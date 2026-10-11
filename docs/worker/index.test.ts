import { describe, expect, test } from "bun:test";
import worker from "./index";

function assets(status = 404) {
	return {
		ASSETS: {
			async fetch() {
				return new Response("<h1>Page not found</h1>", {
					status,
					headers: {
						"Content-Type": "text/html",
						"ETag": '"html"',
						"Vary": "Accept-Encoding",
						"X-Content-Type-Options": "nosniff",
						"Referrer-Policy": "strict-origin-when-cross-origin"
					}
				});
			}
		}
	};
}

describe("missing-path negotiation", () => {
	test.each(["text/markdown", "application/json, text/markdown; q=0.8", "TEXT/MARKDOWN; charset=utf-8"])(
		"returns a helpful Markdown 404 for %s",
		async (accept) => {
			const response = await worker.fetch(new Request("https://zinn.sh/missing", { headers: { accept } }), assets());
			expect(response.status).toBe(404);
			expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
			const body = await response.text();
			expect(body.length).toBeGreaterThanOrEqual(20);
			expect(body).toContain("[llms.txt](https://zinn.sh/llms.txt)");
			expect(response.headers.get("Vary")).toBe("Accept-Encoding, Accept");
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			expect(response.headers.get("ETag")).toBeNull();
			expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		}
	);

	test.each(["", "*/*", "text/html", "text/markdown;q=0", "text/html, text/markdown;q=0.5", "text/*, text/markdown;q=0.5"])(
		"preserves HTML errors for %s",
		async (accept) => {
			const response = await worker.fetch(new Request("https://zinn.sh/missing", { headers: { accept } }), assets());
			expect(response.status).toBe(404);
			expect(response.headers.get("Content-Type")).toBe("text/html");
			expect(await response.text()).toBe("<h1>Page not found</h1>");
			expect(response.headers.get("Vary")).toContain("Accept");
		}
	);

	test.each(["text/markdown", "text/html"])("HEAD has no body for %s", async (accept) => {
		const response = await worker.fetch(new Request("https://zinn.sh/missing", { method: "HEAD", headers: { accept } }), assets());
		expect(response.status).toBe(404);
		expect(response.headers.get("Content-Type")).toStartWith(accept);
		expect(await response.text()).toBe("");
	});

	test.each([200, 301, 500])("leaves status %s responses untouched", async (status) => {
		const response = await worker.fetch(new Request("https://zinn.sh/", { headers: { accept: "text/markdown" } }), assets(status));
		expect(response.status).toBe(status);
		expect(response.headers.get("Content-Type")).toBe("text/html");
		expect(response.headers.get("Cache-Control")).toBeNull();
	});

	test("preserves non-read methods", async () => {
		const response = await worker.fetch(new Request("https://zinn.sh/missing", { method: "POST", headers: { accept: "text/markdown" } }), assets());
		expect(response.headers.get("Content-Type")).toBe("text/html");
	});
});
