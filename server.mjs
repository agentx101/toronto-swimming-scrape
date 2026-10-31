import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 8090);
const addressResource = "0b3756af-9caf-4f0f-ac28-9c6617adede4";
const cityApi = "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/datastore_search";
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function proxyTorontoAddresses(requestUrl, response) {
  const query = requestUrl.searchParams.get("q")?.trim() || "";
  const limit = Math.min(8, Math.max(1, Number(requestUrl.searchParams.get("limit")) || 5));
  if (query.length < 3) return sendJson(response, 200, { success: true, result: { records: [] } });

  const params = new URLSearchParams({ resource_id: addressResource, q: query, limit: String(limit) });
  try {
    const upstream = await fetch(`${cityApi}?${params}`, { headers: { Accept: "application/json" } });
    const payload = await upstream.text();
    response.writeHead(upstream.status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(payload);
  } catch {
    sendJson(response, 502, { success: false, error: "Toronto address service is unavailable" });
  }
}

createServer(async (request, response) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  if (requestUrl.pathname === "/api/toronto-addresses") return proxyTorontoAddresses(requestUrl, response);

  const relativePath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.replace(/^\/+/, "");
  const filePath = resolve(root, normalize(relativePath));
  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return response.end("Not found");
  }
  response.writeHead(200, { "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`Toronto activity finder running at http://127.0.0.1:${port}`);
});
