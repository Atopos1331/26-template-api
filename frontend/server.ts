import { join, normalize } from "node:path";

const root = join(import.meta.dir);
const port = Number(Bun.env.FRONTEND_PORT ?? 4173);
const hostname = Bun.env.FRONTEND_HOST ?? "0.0.0.0";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("FRONTEND_PORT must be a TCP port");
}

const server = Bun.serve({
  hostname,
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(
      url.pathname === "/" ? "/index.html" : url.pathname,
    );
    const filePath = normalize(join(root, pathname));
    if (!filePath.startsWith(`${root}/`))
      return new Response("Not Found", { status: 404 });

    const file = Bun.file(filePath);
    if (!(await file.exists()))
      return new Response("Not Found", { status: 404 });
    return new Response(file);
  },
});

console.log(`Frontend console listening at http://${hostname}:${server.port}`);
