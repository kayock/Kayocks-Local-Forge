// Same-origin companion gateway — sandbox/demo deployments ONLY.
//
// The IDE normally talks to the customer's own companion directly
// (http://127.0.0.1:7337 on THEIR machine). This route exists for sandboxed
// previews where the browser cannot reach loopback: it forwards
// /lf-companion/* to a companion running on THIS web server's localhost.
//
// It is disabled unless a deployment explicitly opts in with BOTH:
//   1. LF_ENABLE_COMPANION_GATEWAY=1        (dev preview: enough on its own)
//   2. LF_FORCE_SANDBOX_GATEWAY=1           (required in production builds —
//      defense in depth against a stray flag leaking in via a bundled .env;
//      the build script strips .env from the standalone bundle, and this
//      second key makes that class of leak harmless)
//
// Customer deployments set neither, so prompts, source code and inference
// traffic can never be routed through the hosted server by accident.
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const COMPANION_ORIGIN = process.env.LF_COMPANION_GATEWAY_TARGET || 'http://127.0.0.1:7337';

function gatewayDisabled() {
  if (process.env.LF_ENABLE_COMPANION_GATEWAY !== '1') return true;
  if (process.env.NODE_ENV === 'production' && process.env.LF_FORCE_SANDBOX_GATEWAY !== '1') return true;
  return false;
}

const DISABLED_MESSAGE = {
  error: 'Companion gateway is disabled on this deployment. The hosted server cannot reach YOUR computer — install the LocalForge companion locally and connect in "Direct" mode.',
};

const HOP_BY_HOP = [
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
];

async function proxy(req: NextRequest, path: string[]): Promise<NextResponse> {
  if (gatewayDisabled()) {
    return NextResponse.json(DISABLED_MESSAGE, { status: 404 });
  }
  const incoming = new URL(req.url);
  const target = `${COMPANION_ORIGIN}/${path.join('/')}${incoming.search}`;
  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    if (HOP_BY_HOP.includes(k.toLowerCase()) || k.toLowerCase() === 'host') continue;
    headers.set(k, v);
  }
  headers.set('host', new URL(COMPANION_ORIGIN).host);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      redirect: 'manual',
    });
  } catch {
    return NextResponse.json(
      { error: `Companion gateway target unreachable at ${COMPANION_ORIGIN}. Is the companion running?` },
      { status: 502 },
    );
  }

  const outHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.includes(k.toLowerCase())) outHeaders.set(k, v);
  });
  const stream = upstream.body
    ? new ReadableStream({
        start(controller) {
          upstream.body!.pipeTo(
            new WritableStream({
              write(chunk) { controller.enqueue(chunk); },
              close() { controller.close(); },
              abort(reason) { controller.error(reason); },
            }),
          ).catch((e) => controller.error(e));
        },
      })
    : null;
  return new NextResponse(stream, { status: upstream.status, headers: outHeaders });
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) { return proxy(req, (await ctx.params).path); }
export async function POST(req: NextRequest, ctx: Ctx) { return proxy(req, (await ctx.params).path); }
export async function PUT(req: NextRequest, ctx: Ctx) { return proxy(req, (await ctx.params).path); }
export async function PATCH(req: NextRequest, ctx: Ctx) { return proxy(req, (await ctx.params).path); }
export async function DELETE(req: NextRequest, ctx: Ctx) { return proxy(req, (await ctx.params).path); }
export async function OPTIONS(req: NextRequest, ctx: Ctx) { return proxy(req, (await ctx.params).path); }
