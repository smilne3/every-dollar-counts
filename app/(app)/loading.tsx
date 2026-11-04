// What every tab shows from the tap until its page has been read (#156). Every page under app/(app)
// is dynamic, and without a loading boundary Next had nothing of them to show before the server had
// read it: a tap left the old page up, unchanged, until the new one was ready. This one boundary
// covers every tab, as app/(app)/error.tsx does. The tab bar's links prefetch the layout down to it,
// so a tap shows it at once. A full page load streams it first, once the layout's sign-in check and
// household-name read are done (app/(app)/layout.tsx), so the response's status is sent
// before the page is read: a page whose read fails answers 200, and one not found answers 200 with
// noindex (Next's loading.js docs, "Status codes").
//
// Plain shapes, since it stands in for every page: a figure here would be one with no "isn't
// syncing" banner beside it (#135), and a word or link one that no page asked for. The title bar has
// PageHeader's title's size and place, so the title does not move when the page arrives. Every shape
// is filled, with no white card or border, so with Reduce Motion on, when the pulse stops, it still
// reads as a placeholder rather than a page that loaded empty.
//
// A link that opens a page on one of its parts names the part with a query, not a #fragment, as
// CATEGORY_RULES_HREF (lib/settings-links.ts) does, and ScrollToSection in that page scrolls to it.
// Under this boundary a tapped link's address is already showing, with this placeholder, before its
// page has been read. If reading it fails, Next's router falls back to loading that address in full, and to
// an address with a #fragment the browser takes that as a jump within the page: nothing loads, and
// the placeholder stays up. An address with a query loads in full.
export default function Loading() {
  return (
    <div role="status" className="space-y-6">
      <span className="sr-only">Loading…</span>
      <div aria-hidden="true" className="space-y-6 motion-safe:animate-pulse">
        <div className="space-y-2">
          <div className="h-8 w-40 max-w-full rounded-lg bg-line" />
          <div className="h-4 w-56 max-w-full rounded-md bg-line/60" />
        </div>
        <div className="h-40 rounded-card bg-line" />
      </div>
    </div>
  )
}
