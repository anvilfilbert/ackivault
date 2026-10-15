import { request, type Server } from "node:http";

export type HostedResponse = { status: number; text: string };
export async function hostedRequest(port: number, token: string, origin: string, method: string, body: string): Promise<HostedResponse> {
  return new Promise<HostedResponse>((resolve, reject): void => {
    const call = request({ host: "127.0.0.1", port, path: method === "POST" ? "/api/action" : "/api/snapshot", method,
      headers: { host: new URL(origin).host, origin, "cf-access-jwt-assertion": token, "content-type": "application/json" } }, (response): void => {
      let text = "";
      response.setEncoding("utf8"); response.on("data", (chunk: string): void => { text += chunk; });
      response.on("end", (): void => { if (response.statusCode === undefined) reject(new Error("Hosted response has no status code")); else resolve({ status: response.statusCode, text }); });
      response.on("error", reject);
    }); call.on("error", reject); call.end(body);
  });
}
export async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject): void => { server.close((error): void => { if (error) reject(error); else resolve(); }); });
}
