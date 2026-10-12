import { request } from "node:http";

export async function hostStatus(url: string, host: string): Promise<number> {
  return new Promise<number>((resolve, reject): void => {
    const call = request(url, { headers: { host } }, (response): void => {
      response.resume();
      if (response.statusCode === undefined) reject(new Error("HTTP response is missing its status code"));
      else resolve(response.statusCode);
    });
    call.on("error", reject);
    call.end();
  });
}
