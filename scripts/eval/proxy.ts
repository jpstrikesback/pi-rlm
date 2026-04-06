import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ProxyLogEntry, ProxyUsage } from "./types.js";

type ProxyContext = {
	turnIndex: number;
	turnId: string;
};

export async function startLoggingProxy(options: {
	upstreamBaseUrl: string;
	parseUsage?: (responseText: string) => ProxyUsage | undefined;
}): Promise<{
	baseUrl: string;
	logs: ProxyLogEntry[];
	setContext: (context: ProxyContext) => void;
	close: () => Promise<void>;
}> {
	const upstreamBaseUrl = options.upstreamBaseUrl.replace(/\/$/, "");
	const logs: ProxyLogEntry[] = [];
	let currentContext: ProxyContext = { turnIndex: -1, turnId: "setup" };

	const server = createServer(async (req, res) => {
		try {
			await handleRequest(req, res, {
				upstreamBaseUrl,
				context: currentContext,
				logs,
				parseUsage: options.parseUsage,
			});
		} catch (error) {
			res.statusCode = 500;
			res.end(String(error instanceof Error ? error.stack || error.message : error));
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});

	const address = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		logs,
		setContext(context) {
			currentContext = context;
		},
		close() {
			return new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	options: {
		upstreamBaseUrl: string;
		context: ProxyContext;
		logs: ProxyLogEntry[];
		parseUsage?: (responseText: string) => ProxyUsage | undefined;
	},
) {
	const requestId = randomUUID();
	const startedAt = new Date().toISOString();
	const body = await readBody(req);
	const requestBodyText = body.toString("utf8");
	const upstreamUrl = joinUpstreamUrl(options.upstreamBaseUrl, req.url || "/");
	const requestInit: RequestInit & { duplex?: "half" } = {
		method: req.method,
		headers: filteredHeaders(req.headers),
		body: hasRequestBody(req.method) ? new Uint8Array(body) : undefined,
	};
	if (hasRequestBody(req.method)) requestInit.duplex = "half";
	const response = await fetch(upstreamUrl, requestInit);

	res.statusCode = response.status;
	for (const [key, value] of response.headers.entries()) {
		if (key.toLowerCase() === "content-length") continue;
		res.setHeader(key, value);
	}

	let responseText = "";
	if (response.body) {
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			res.write(Buffer.from(value));
			responseText += decoder.decode(value, { stream: true });
		}
		responseText += decoder.decode();
	} else {
		responseText = await response.text();
		res.write(responseText);
	}
	res.end();

	options.logs.push({
		requestId,
		method: req.method || "GET",
		path: req.url || "/",
		url: upstreamUrl,
		requestBodyText,
		requestBodyJson: tryParseJson(requestBodyText),
		responseStatus: response.status,
		responseText,
		startedAt,
		durationMs: Math.max(Date.now() - new Date(startedAt).getTime(), 0),
		turnIndex: options.context.turnIndex,
		turnId: options.context.turnId,
		usage: options.parseUsage?.(responseText),
	});
}

export async function startMlxLoggingProxy(options: {
	upstreamBaseUrl: string;
	parseUsage?: (responseText: string) => ProxyUsage | undefined;
}) {
	return startLoggingProxy(options);
}

function filteredHeaders(headers: IncomingMessage["headers"]): Headers {
	const next = new Headers();
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		if (key.toLowerCase() === "host") continue;
		if (Array.isArray(value)) {
			for (const inner of value) next.append(key, inner);
		} else {
			next.set(key, value);
		}
	}
	return next;
}

function hasRequestBody(method: string | undefined): boolean {
	return !!method && !["GET", "HEAD"].includes(method.toUpperCase());
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

function joinUpstreamUrl(baseUrl: string, requestPath: string): string {
	const trimmedBase = baseUrl.replace(/\/$/, "");
	const normalizedPath = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
	return `${trimmedBase}${normalizedPath}`;
}

function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
