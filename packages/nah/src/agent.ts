/**
 * The agent surface the Studio imports.
 *
 * `nah` is a terminal program, and a dashboard that copied its prompt assembly
 * would be debugging a different agent than the one it claims to watch. So the one
 * build of it that another package needs is published as a subpath: read-only,
 * stateless, and traced — everything the Studio's chat tab and evaluations need,
 * and nothing that would let a browser drive the agent you use.
 */

export {
  createReadonlyAgent,
  type StudioAgent,
  type StudioAgentOptions,
  type StudioAgentRun,
  type StudioWorkflowRunner,
} from "./studio-agent.js";