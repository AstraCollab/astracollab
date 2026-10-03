"use client"

import { useEffect, useRef, type ReactNode } from "react"

/**
 * Reveal on scroll.
 *
 * A scroll animation needs to know where the viewport is, which is the one thing
 * a server component cannot know. So the server renders the final state and this
 * marks the element as *not yet shown* only after hydration — which is the
 * opposite order to the usual approach and is the reason this cannot flash or
 * strand content:
 *
 *   - No JavaScript at all? `data-reveal` is never set, the hiding rule in
 *     `globals.css` never matches, and the content is simply visible.
 *   - `prefers-reduced-motion: reduce`? The root never gets `data-motion="ok"`,
 *     so again the content is visible and nothing animates.
 *   - JavaScript, motion allowed? `data-reveal` is set, the element starts
 *     hidden, and `data-shown` is added when it first intersects.
 *
 * The alternative — hiding in CSS and revealing from JavaScript — is what leaves a
 * documentation page blank for anyone with a flaky connection or a reader that
 * blocks scripts.
 *
 * The attribute is written straight to the node rather than held in state. The
 * only thing this component produces is `data-shown`, and the only consumer of it
 * is CSS, so routing that through a state update would buy a re-render of every
 * reveal on the page for no benefit.
 */
export function Reveal({
  children,
  delay = 0,
  className = ""
}: {
  children: ReactNode
  /** Stagger in ms. Applied as a transition-delay, not a setTimeout. */
  delay?: number
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = ref.current
    if (element === null) return

    const show = () => element.setAttribute("data-shown", "true")

    // No IntersectionObserver means no reveal, rather than content stuck at
    // opacity zero forever.
    if (typeof IntersectionObserver === "undefined") {
      show()
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          show()
          observer.disconnect()
        }
      },
      // Fire a little before it is properly on screen, so the animation has
      // finished by the time the reader is actually looking at it.
      { rootMargin: "0px 0px -12% 0px", threshold: 0.05 }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      data-reveal=""
      style={delay > 0 ? { transitionDelay: `${delay}ms` } : undefined}
      className={className}
    >
      {children}
    </div>
  )
}
