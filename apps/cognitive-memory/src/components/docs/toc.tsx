"use client"

import { useEffect, useState } from "react"

/**
 * The table of contents, and where you are in the page.
 *
 * A contents list that does not move is a list you have to compare against the
 * page yourself. Highlighting the section you are reading is what turns it from
 * a table of contents into navigation — on a reference page, the question "am I
 * nearly at the end of this, or is there another screenful" is answered by
 * looking at the rail rather than by scrolling to find out.
 *
 * IntersectionObserver rather than a scroll handler: this runs on the main
 * thread of a page whose whole job is to stay out of the way, and the observer
 * is already batched by the browser. The root margin biases the "current"
 * section towards the top of the viewport, which is where a reader's eye is.
 */
export function Toc({
  sections,
  variant
}: {
  sections: ReadonlyArray<{ id: string; title: string }>
  variant: "rail" | "inline"
}) {
  const [active, setActive] = useState<string | null>(sections[0]?.id ?? null)

  useEffect(() => {
    if (sections.length === 0) return
    const elements = sections
      .map((section) => document.getElementById(section.id))
      .filter((element): element is HTMLElement => element !== null)
    if (elements.length === 0) return

    const visible = new Set<string>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id)
          else visible.delete(entry.target.id)
        }
        // The first visible section in document order wins, so scrolling up
        // highlights the section above rather than the one below.
        const first = sections.find((section) => visible.has(section.id))
        if (first) setActive(first.id)
      },
      // Bias the band to the upper part of the viewport: a heading that has just
      // scrolled past the top is the one being read.
      { rootMargin: "-80px 0px -65% 0px", threshold: 0 }
    )

    for (const element of elements) observer.observe(element)
    return () => observer.disconnect()
  }, [sections])

  return (
    <ul
      className={`space-y-1.5 border-l border-white/[0.06] pl-3 ${
        variant === "inline" ? "mt-3" : "mt-3"
      }`}
    >
      {sections.map((section) => {
        const current = active === section.id
        return (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              aria-current={current ? "location" : undefined}
              className={`-ml-px block border-l py-0.5 pl-2 text-[12px] leading-5 transition ${
                current
                  ? "border-violet-400/70 text-zinc-200"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {section.title}
            </a>
          </li>
        )
      })}
    </ul>
  )
}
