import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

/**
 * Explain what a codebase is, and write the answer to a markdown file at its root.
 *
 * The shape of the answer is knowable in advance and the only thing that varies is the
 * repository, so it belongs in a workflow: every run reads the same way, and the
 * model's job shrinks from "remember what onboarding a repo means" to "do it".
 *
 * Gathering runs inline. Listing the workspace packages, reading their manifests and
 * walking their source trees is fact work the shell already knows how to do, and
 * spending a model call on `git ls-files` buys a string that can come back wrong in a
 * way that only shows up as a confidently wrong report. Delegation starts at the step
 * that needs judgement: reading code and saying what it is for.
 */

/** Directories that are build output, vendored code, or noise. Never source. */
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "coverage", ".next", ".nuxt", ".svelte-kit",
  ".turbo", ".git", ".vercel", ".output", ".cache", "storybook-static", "__snapshots__",
  "__pycache__", ".venv", "venv", "target", "vendor", "examples",
]);

/** Extensions worth explaining. A stylesheet is not what "what does this do" means. */
const SOURCE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs", ".swift",
  ".ex", ".exs", ".scala", ".vue", ".svelte", ".astro", ".sql", ".prisma",
]);

/** Config and docs: worth handing a child, worth less than code. */
const CONTEXT_EXT = new Set([".md", ".json", ".yaml", ".yml", ".toml"]);

/** Files that describe how a package is built rather than what it does. */
const CONTEXT_FILES = new Set([
  "package.json", "tsconfig.json", "turbo.json", "vercel.json", "pnpm-workspace.yaml",
  "next.config.ts", "next.config.mjs", "vite.config.ts", "vite.config.mts",
  "drizzle.config.ts", "docker-compose.yml", "Dockerfile", "pyproject.toml", "Cargo.toml",
]);

/** Never worth a child's time, whatever directory it sits in. */
const IGNORED_FILE = /(\.d\.ts|\.min\.js|\.map|\.snap|\.test\.|\.spec\.)$/;

const MAX_WALK_DEPTH = 8;
const MAX_FILES_PER_TREE = 600;
const MAX_FILES_PER_PACKAGE = 40;

/**
 * Ceiling on batches, which is the ceiling on concurrent child agents.
 *
 * `.map` refuses to fan out past 64 items, and a large repository handed to one child
 * per package at once is a stampede that reads the whole tree into one context window.
 * The budget is derived from the total, so the run stays bounded as the repo grows.
 */
const MAX_BATCHES = 12;

const extnameOf = (file) => {
  const dot = file.lastIndexOf(".");
  return dot <= 0 ? "" : file.slice(dot);
};

const isContextFile = (file) => CONTEXT_FILES.has(file) || CONTEXT_EXT.has(extnameOf(file));

/**
 * How interesting a file is, so a cap keeps the entry points rather than the trivia.
 * Lower is more interesting.
 */
const rankOf = (relPath) => {
  const file = relPath.split("/").pop();
  if (/(^|\/)src\/(index|main|app|server)\./.test(relPath)) return 0;
  if (/^(index|main|app|server)\.[a-z]+$/.test(file)) return 1;
  if (/^src\/[^/]+\.[a-z]+$/.test(relPath)) return 2;
  if (CONTEXT_FILES.has(file)) return 3;
  if (/\.md$/.test(file)) return 4;
  if (SOURCE_EXT.has(extnameOf(file))) return 5;
  return 6;
};

const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    // A missing or malformed manifest is a fact about the repository, not a reason to
    // fail a step whose whole job is describing it.
    return undefined;
  }
};

const listDirectories = async (dir) => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

/**
 * Expand the workspace globs a repository actually uses.
 *
 * pnpm's `pnpm-workspace.yaml` and the `workspaces` field of an npm, yarn or bun
 * manifest are both read, along with the bare `apps/*` + `packages/*` convention,
 * because a monorepo that lists its packages in one of those and not the others would
 * otherwise look empty. Only depth-1 globs are expanded: a `**` pattern or a negation
 * is skipped rather than half-implemented, and `paths` still points at anything directly.
 */
const workspacePatterns = async (root) => {
  const patterns = new Set(["apps/*", "packages/*"]);

  const manifest = await readJson(join(root, "package.json"));
  const workspaces = Array.isArray(manifest?.workspaces) ? manifest.workspaces : manifest?.workspaces?.packages;
  for (const entry of Array.isArray(workspaces) ? workspaces : []) {
    if (typeof entry === "string") patterns.add(entry);
  }

  try {
    const yaml = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
    let inPackages = false;
    for (const raw of yaml.split("\n")) {
      const line = raw.replace(/#.*$/, "").trimEnd();
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      // Dedented back to the document root: the list is over, and the next key
      // (catalogs, overrides) is not a package location.
      if (inPackages && /^\S/.test(raw)) inPackages = false;
      const entry = line.match(/^\s+-\s*["']?([^"'#]+?)["']?\s*$/);
      if (inPackages && entry) patterns.add(entry[1]);
    }
  } catch {
    // No pnpm workspace file is the normal state of an npm or yarn monorepo.
  }

  return [...patterns].filter((pattern) => !pattern.startsWith("!") && !pattern.includes("**"));
};

/** Every directory the workspace globs resolve to, that actually holds a manifest. */
const findPackageDirs = async (root) => {
  const dirs = new Set([""]);
  for (const pattern of await workspacePatterns(root)) {
    if (pattern.endsWith("/*")) {
      const parent = join(root, pattern.slice(0, -2));
      for (const name of await listDirectories(parent)) dirs.add(relative(root, join(parent, name)));
    } else {
      dirs.add(pattern);
    }
  }
  const found = [];
  for (const dir of dirs) {
    if (await readJson(join(root, dir, "package.json"))) found.push(dir);
  }
  return found.sort();
};

/**
 * Walk one package and return its source files, most interesting first.
 *
 * Capped per tree so a data directory or a vendored blob does not spend the whole run
 * enumerating, and capped per package so one package cannot crowd out the rest.
 */
const collectFiles = async (root, dir, maxFiles) => {
  const base = join(root, dir);
  const found = [];
  const walk = async (current, depth) => {
    if (depth > MAX_WALK_DEPTH || found.length >= MAX_FILES_PER_TREE) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES_PER_TREE) return;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(join(current, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile() || IGNORED_FILE.test(entry.name)) continue;
      if (!SOURCE_EXT.has(extnameOf(entry.name)) && !isContextFile(entry.name)) continue;
      found.push(relative(base, join(current, entry.name)).split(sep).join("/"));
    }
  };
  await walk(base, 0);
  return found.sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b)).slice(0, maxFiles);
};

/**
 * The edges between workspace packages, from the manifests rather than from a guess.
 *
 * A `workspace:` protocol is an explicit claim about the local graph; a dependency
 * whose name matches another workspace package is a real edge too, protocol or not.
 */
const localEdges = (packages) => {
  const byName = new Map(packages.map((entry) => [entry.name, entry.dir]));
  const edges = [];
  for (const entry of packages) {
    for (const [kind, deps] of [["dependency", entry.dependencies], ["peer", entry.peers]]) {
      for (const [name, range] of Object.entries(deps ?? {})) {
        const target = byName.get(name);
        if (target !== undefined && target !== entry.dir) {
          edges.push({ from: entry.dir, to: target, kind, range: String(range) });
        }
      }
    }
  }
  return edges;
};

/**
 * Group the packages into batches roughly even in source files.
 *
 * Evenness is the point: eight tiny packages finish in seconds while eight large ones
 * get summarised, and an uneven split makes the report's depth depend on how the
 * packages happen to be sized.
 */
const planBatches = (targets) => {
  const sizeOf = (target) => (target.files ?? []).length;
  const totalFiles = targets.reduce((total, target) => total + sizeOf(target), 0);
  const budget = Math.max(1, Math.ceil(totalFiles / MAX_BATCHES));
  const batches = [];
  let current = [];
  let used = 0;
  for (const target of targets) {
    // A package always ships, even alone and even empty: an unexplained package is a
    // hole in the report, and an empty one is itself a finding.
    if (current.length > 0 && used + sizeOf(target) > budget) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(target);
    used += sizeOf(target);
  }
  if (current.length > 0) batches.push(current);
  return batches;
};

const bullet = (items) => items.map((item) => `- ${item}`).join("\n");

/** Split a comma-separated line the child was asked to end its answer with. */
const parseList = (text) =>
  (text ?? "")
    .split(",")
    .map((item) => item.replace(/^[-*\d.\s]+/, "").replace(/`/g, "").trim())
    .filter(Boolean);

export default ({ createStep, createWorkflow, z }) => {
  const targetSchema = z.object({
    dir: z.string(),
    name: z.string(),
    description: z.string(),
    files: z.array(z.string()),
  });

  const batchSchema = z.object({
    label: z.string(),
    targets: z.array(targetSchema),
  });

  const explanationSchema = z.object({
    label: z.string(),
    dirs: z.array(z.string()),
    summary: z.string(),
    keyFiles: z.array(z.string()),
  });

  const overviewSchema = z.object({
    overview: z.string(),
    architecture: z.string(),
    readingOrder: z.array(z.string()),
  });

  /**
   * The synthesis carries the package notes onward rather than replacing them: `.then`
   * hands the next step only what the previous one returned, so a synthesis returning
   * the overview alone would leave the report with nothing to write about.
   */
  const synthesisSchema = overviewSchema.extend({ explanations: z.array(explanationSchema) });

  const requireDelegate = (context) => {
    const delegate = context?.delegate;
    if (typeof delegate !== "function") {
      throw new Error("explain-codebase needs `context.delegate`; run it through nah, which hands one to every step");
    }
    return delegate;
  };

  /**
   * The facts every later step needs, carried in state rather than threaded through the
   * chain: `.then` replaces the value outright, so anything a later step reads has to
   * be returned again or kept here.
   */
  const inventoryPackages = createStep({
    id: "inventory-packages",
    description: "Find every workspace package and read what its manifest says about it, plus the edges between them.",
    outputSchema: z.object({ packages: z.array(z.any()), edges: z.array(z.any()) }),
    execute: async ({ inputData, setState }) => {
      const input = inputData ?? {};
      const root = resolve(input.root ?? process.cwd());

      const dirs = await findPackageDirs(root);
      const selected = input.paths?.length ? dirs.filter((dir) => input.paths.some((path) => dir.includes(path))) : dirs;

      const packages = [];
      for (const dir of selected) {
        const manifest = await readJson(join(root, dir, "package.json"));
        packages.push({
          dir,
          label: dir === "" ? "<repository root>" : dir,
          name: manifest?.name ?? dir,
          description: manifest?.description ?? "",
          dependencies: manifest?.dependencies ?? {},
          peers: manifest?.peerDependencies ?? {},
          files: [],
        });
      }

      const edges = localEdges(packages);
      setState({
        root,
        edges,
        packages,
        outputFile: input.outputFile ?? "CODEBASE.md",
        maxFilesPerPackage: input.maxFilesPerPackage ?? MAX_FILES_PER_PACKAGE,
      });
      return { packages, edges };
    },
  });

  const collectSource = createStep({
    id: "collect-source",
    description: "Walk each package's tree and list the source files a reader should start with. Facts only; reads files.",
    inputSchema: z.object({ packages: z.array(z.any()) }),
    outputSchema: z.object({ packages: z.array(z.any()), targets: z.array(targetSchema) }),
    execute: async ({ inputData, state, setState }) => {
      const { root, maxFilesPerPackage } = state;
      const packages = [];
      const targets = [];
      for (const pkg of inputData.packages) {
        const files = await collectFiles(root, pkg.dir, maxFilesPerPackage);
        packages.push({ ...pkg, files });
        targets.push({ dir: pkg.dir, name: pkg.name, description: pkg.description, files });
      }
      setState({ packages, targets });
      return { packages, targets };
    },
  });

  const planExplanations = createStep({
    id: "plan-explanations",
    description: "Group the packages into batches even in size, so no child is given more repository than it can actually read.",
    inputSchema: z.object({ targets: z.array(targetSchema) }),
    outputSchema: z.object({ batches: z.array(batchSchema) }),
    execute: async ({ inputData }) => ({
      batches: planBatches(inputData.targets).map((group) => ({
        label: group.map((target) => (target.dir === "" ? "<root>" : target.dir)).join(", "),
        targets: group,
      })),
    }),
  });

  const explainBatch = createStep({
    id: "explain-batch",
    description: "One child reads the listed source files for its packages and says what they do. Reads code; edits nothing.",
    inputSchema: batchSchema,
    outputSchema: explanationSchema,
    execute: async ({ inputData, context, signal, writer }) => {
      const delegate = requireDelegate(context);
      writer(`reading ${inputData.label}\n`);

      const briefs = inputData.targets.map((target) => {
        const where = target.dir === "" ? "the repository root" : `the package at ${target.dir}`;
        return [
          `--- ${where} ---`,
          `name: ${target.name}${target.description ? `\ndeclared purpose: ${target.description}` : ""}`,
          target.files.length > 0
            ? `files to read, most important first:\n${target.files.map((file) => `  ${target.dir === "" ? "" : `${target.dir}/`}${file}`).join("\n")}`
            : "files: none found outside build output or vendored directories — say so rather than inventing one",
        ].join("\n");
      });

      const result = await delegate({
        title: `explain ${inputData.label}`,
        task: [
          "Read the source files listed below and explain what this part of the repository actually does. Paths are relative to the repository root.",
          briefs.join("\n\n"),
          "Read the files with your tools before describing them. Do not report what a package name or a README claims it does; report what the code does.",
          "Write for someone who has never seen this repository. Name real files and real functions, not categories.",
          "For each package give: what it is for, what it exposes to the rest of the repository, and how it is actually used. Then name the three to six files that matter most for understanding it.",
          "Say plainly when a package is a stub, dead weight, or too tangled to summarise. An honest 'this is unclear' costs less than a confident wrong answer.",
          "Finish with a final line beginning `KEY FILES:` listing the paths that mattered most, comma separated.",
        ].join("\n\n"),
        signal,
      });

      const text = (result.text ?? "").trim();
      return {
        label: inputData.label,
        dirs: inputData.targets.map((target) => target.dir),
        summary: text.replace(/\n?KEY FILES:[\s\S]*$/i, "").trim() || "(the reader returned no notes for these packages)",
        keyFiles: parseList(text.match(/KEY FILES:?\s*(.+)/i)?.[1]),
      };
    },
  });

  const synthesizeRepo = createStep({
    id: "synthesize-repo",
    description: "One child reads every package's notes and the dependency edges, and explains the repository as a whole.",
    inputSchema: z.object({ explanations: z.array(explanationSchema) }),
    outputSchema: synthesisSchema,
    execute: async ({ inputData, state, context, signal, writer }) => {
      const delegate = requireDelegate(context);
      const { explanations } = inputData;
      const { edges } = state;
      writer("synthesising the repository as a whole\n");

      const edgeText =
        edges.length > 0
          ? ["Workspace-internal dependencies, read from the manifests:", bullet(edges.map(({ from, to, kind }) => `${from || "<root>"} --${kind}--> ${to || "<root>"}`))].join("\n")
          : "Workspace-internal dependencies: none found in the manifests.";

      const result = await delegate({
        title: "explain the repository",
        task: [
          "Below are notes on each package of this monorepo, written by other readers who went and read the code. Write the explanation of the repository as a whole.",
          edgeText,
          "",
          ...explanations.map(({ label, summary }) => `=== ${label} ===\n${summary}`),
          "",
          "Produce exactly two labelled sections.",
          "OVERVIEW: three to five sentences on what this repository is and who it is for, in plain language, with no hedging and no restating the package names.",
          "ARCHITECTURE: the shape of the whole. How the packages divide the work, which ones everything else depends on, which are leaves, and anything surprising. Markdown, subheadings welcome.",
          "Then, on a final line beginning `READING ORDER:`, list what a newcomer should read in order, comma separated, most foundational first.",
        ].join("\n"),
        signal,
      });

      const text = (result.text ?? "").trim();
      return {
        overview: text.match(/OVERVIEW:?\s*([\s\S]*?)(?=\nARCHITECTURE|\nREADING ORDER|$)/i)?.[1]?.trim() || text,
        architecture: text.match(/ARCHITECTURE:?\s*([\s\S]*?)(?=\nREADING ORDER|$)/i)?.[1]?.trim() || "",
        readingOrder: parseList(text.match(/READING ORDER:?\s*(.+)/i)?.[1]),
        explanations,
      };
    },
  });

  const writeReport = createStep({
    id: "write-report",
    description: "Assemble the package notes and the overview into one markdown file at the repository root. Overwrites the previous run.",
    inputSchema: synthesisSchema,
    outputSchema: z.object({ file: z.string(), packages: z.number(), filesRead: z.number(), markdown: z.string() }),
    execute: async ({ inputData, state }) => {
      const { overview, architecture, readingOrder, explanations } = inputData;
      const { root, outputFile, packages, edges } = state;
      const file = join(root, outputFile);

      const notesByDir = new Map();
      for (const explanation of explanations) {
        for (const dir of explanation.dirs) {
          notesByDir.set(dir, { summary: explanation.summary, keyFiles: explanation.keyFiles });
        }
      }

      const filesRead = packages.reduce((total, pkg) => total + (pkg.files ?? []).length, 0);
      const sections = [
        `# ${packages[0]?.name || "This repository"}`,
        "",
        `_Written by the \`explain-codebase\` workflow on ${new Date().toISOString().slice(0, 10)}. ${packages.length} packages, ${filesRead} source files read._`,
        "",
        "## What this is",
        "",
        overview || "_The overview step returned nothing._",
        "",
        "## How it fits together",
        "",
        architecture || "_The architecture step returned nothing._",
      ];

      if (readingOrder.length > 0) {
        sections.push("", "## Where to start reading", "", ...readingOrder.map((item, index) => `${index + 1}. ${item}`));
      }

      sections.push("", "## The packages", "");
      for (const pkg of packages) {
        const where = pkg.dir === "" ? "<repository root>" : pkg.dir;
        const deps = Object.keys(pkg.dependencies ?? {});
        const incoming = edges.filter((edge) => edge.to === pkg.dir).map((edge) => edge.from || "<root>");
        sections.push(
          `### ${where}`,
          "",
          `- **Package**: \`${pkg.name}\`${pkg.description ? ` — ${pkg.description}` : ""}`,
          `- **Depends on**: ${deps.length > 0 ? deps.join(", ") : "nothing in this workspace"}`,
          `- **Depended on by**: ${incoming.length > 0 ? incoming.join(", ") : "nothing in this workspace"}`,
          `- **Source files read**: ${(pkg.files ?? []).length}`,
          "",
          notesByDir.get(pkg.dir)?.summary ?? "_No notes were returned for this package._",
          "",
        );
      }

      const withKeyFiles = [...notesByDir.entries()].filter(([, notes]) => notes.keyFiles.length > 0);
      if (withKeyFiles.length > 0) {
        sections.push("## Files that mattered most", "");
        for (const [dir, { keyFiles }] of withKeyFiles) {
          sections.push(`**${dir === "" ? "<repository root>" : dir}**`, "", ...keyFiles.map((path) => `- \`${path}\``), "");
        }
      }

      const markdown = `${sections.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
      await writeFile(file, markdown, "utf8");
      return { file, packages: packages.length, filesRead, markdown };
    },
  });

  return createWorkflow({
    id: "explain-codebase",
    description: "Explain what a codebase is: inventory every workspace package, read the source, and write CODEBASE.md at the repository root.",
    inputSchema: z.object({
      root: z.string().optional().describe("Repository root to explain. Defaults to the directory nah was started in."),
      outputFile: z.string().optional().describe("Markdown file to write, relative to the root. Defaults to CODEBASE.md."),
      paths: z.array(z.string()).optional().describe("Only explain packages whose path contains one of these. Defaults to the whole workspace."),
      maxFilesPerPackage: z.number().optional().describe(`How many source files to read per package, most important first. Defaults to ${MAX_FILES_PER_PACKAGE}.`),
    }),
    outputSchema: z.object({
      file: z.string(),
      packages: z.number(),
      filesRead: z.number(),
      markdown: z.string(),
    }),
  })
    .then(inventoryPackages)
    .then(collectSource)
    .then(planExplanations)
    .map({ inputKey: "batches", outputKey: "explanations", mapper: () => explainBatch })
    .then(synthesizeRepo)
    .then(writeReport)
    .commit();
};
