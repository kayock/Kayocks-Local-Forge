# Third-Party Licenses

LocalForge IDE is MIT-licensed. All third-party runtime dependencies are
commercial-use-compatible (MIT / Apache-2.0 / BSD / ISC family). No copyleft
library is used in the distributed product. Verify with `npx license-checker --summary`.

## Direct dependencies

| Package | License | Use |
| --- | --- | --- |
| next | MIT | App framework |
| react / react-dom | MIT | UI |
| @monaco-editor/react | MIT | Editor wrapper |
| monaco-editor | MIT | Code editor |
| @xterm/xterm, @xterm/addon-fit | MIT | Terminal UI |
| zustand | MIT | State |
| react-resizable-panels | MIT | IDE layout |
| tailwindcss (4) | MIT | Styling |
| Radix UI primitives (@radix-ui/*) | MIT | shadcn/ui base components |
| lucide-react | ISC | Icons |
| prisma / @prisma/client | Apache-2.0 | ORM |
| class-variance-authority | Apache-2.0 | Variant styling |
| clsx, tailwind-merge | MIT | Class utils |
| react-markdown | MIT | Chat rendering |
| next-themes | MIT | Theme |
| sonner | MIT | Toasts |
| framer-motion | MIT | Animations |
| recharts | MIT | Dashboard charts |
| date-fns | MIT | Dates |
| uuid | MIT | IDs |
| zod | MIT | Validation |
| cmdk | MIT | Command palette |
| vaul, embla-carousel-react, input-otp, react-day-picker, react-hook-form, @hookform/resolvers, @tanstack/react-query, @tanstack/react-table | MIT/Apache-2.0 | scaffold extras |
| sharp | Apache-2.0 | Image processing (build tooling) |
| ws (companion) | MIT | WebSocket |
| next-auth (present in scaffold, unused) | MIT | not used at runtime |

## Fonts

- Geist / Geist Mono via next/font — SIL OFL 1.1 (bundled by Vercel, free use).

## Notes

- shadcn/ui components in `src/components/ui` are generated from the shadcn
  template (MIT).
- The companion intentionally has **one** runtime dependency (`ws`) to keep
  its supply chain and packaging surface minimal.
- If Stripe is activated, the server integration uses Stripe's REST API
  directly (no SDK), avoiding an additional dependency.
