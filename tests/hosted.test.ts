import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEl, MockVault, TFile, TFolder, mockReply, notices, openedModals, requestLog } from "obsidian";
import CardsmithPlugin from "../src/main";
import { LicenseManager } from "../src/license/manager";
import { HOSTED_CLIENT_TIMEOUT_MS, HOSTED_CONSENT, HOSTED_COPY, HOSTED_LABEL, HostedError, hostedGenerate, hostedText, hostedUsage, usageText, type HostedUsage } from "../src/ai/hosted";
import { HOSTED_HOURLY_GENS, HOSTED_MONTHLY_BUDGET_USD, HOSTED_MONTHLY_GENS, STRIPE_LICENSE_SERVER_URL } from "../src/config";
import { HostedConsentModal } from "../src/ui/hosted-consent-modal";
import { PRO_MAX_CARDS } from "../src/config";
import { MAX_INPUT_CHARS } from "../src/core/prompt";
import { PRO_FEATURES } from "../src/core/features";
import { ProModal } from "../src/ui/pro-modal";
import { CardsmithSettingTab } from "../src/settings";
import type { HttpFn } from "../src/ai/providers";
import { readFileSync } from "node:fs";

vi.stubGlobal("window", { setInterval: () => 1, open: () => null });

const SERVER = "https://license.example.test";
const USAGE: HostedUsage = { plan: "pro", used: 13, limit: 300, remaining: 287, resetsAt: Date.UTC(2026, 11, 1) };
type Req = { url: string; method: string; body: string };

function fakeHttp(reply: (req: Req) => { status: number; json: unknown }) {
	const calls: Req[] = [];
	const http: HttpFn = async (req) => {
		calls.push(req as Req);
		const r = reply(req as Req);
		return { status: r.status, json: r.json, text: "" };
	};
	return { http, calls };
}

const REQ = { key: "CARDSMITH-AAAA", device: "dev-1", title: "Cells", text: "The cell is the unit of life.", cards: 10, types: ["basic" as const] };

describe("hosted client (pure)", () => {
	it("sends only the allowed fields, model auto, to /v1/generate", async () => {
		const { http, calls } = fakeHttp(() => ({ status: 200, json: { ok: true, text: '{"cards":[]}', usage: USAGE } }));
		const r = await hostedGenerate(http, SERVER + "/", REQ);
		expect(r.usage).toEqual(USAGE);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(`${SERVER}/v1/generate`);
		const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(["cards", "device", "key", "model", "product", "text", "title", "types"]);
		expect(body.model).toBe("auto");
		expect(body.product).toBe("cardsmith");
	});

	it("cuts the note to 24,000 characters and the title to 300", async () => {
		const { http, calls } = fakeHttp(() => ({ status: 200, json: { ok: true, text: "{}" } }));
		await hostedGenerate(http, SERVER, { ...REQ, title: "t".repeat(500), text: "x".repeat(MAX_INPUT_CHARS + 50) });
		const body = JSON.parse(calls[0]!.body) as { text: string; title: string };
		expect(MAX_INPUT_CHARS).toBe(24000);
		expect(body.text).toHaveLength(MAX_INPUT_CHARS);
		expect(body.title).toHaveLength(300);
		expect(hostedText("x".repeat(MAX_INPUT_CHARS + 1)).truncated).toBe(true);
		expect(hostedText("short").truncated).toBe(false);
	});

	it("maps each 429 quota reason to its fallback copy and stops folder runs", async () => {
		for (const reason of ["gens", "cost", "hourly", "trial", "paused", "busy"] as const) {
			const { http } = fakeHttp(() => ({ status: 429, json: { ok: false, code: "hosted_quota", reason, error: "x", usage: USAGE } }));
			const e = await hostedGenerate(http, SERVER, REQ).catch((x: unknown) => x);
			expect(e).toBeInstanceOf(HostedError);
			expect((e as HostedError).message).toBe(HOSTED_COPY[reason]);
			expect((e as HostedError).stop).toBe(true);
			expect((e as HostedError).usage).toEqual(USAGE);
			expect((e as HostedError).message).toMatch(/own key or Ollama|Ollama/);
		}
		const { http } = fakeHttp(() => ({ status: 429, json: { ok: false, code: "hosted_quota", reason: "something-new" } }));
		expect(((await hostedGenerate(http, SERVER, REQ).catch((x: unknown) => x)) as HostedError).message).toBe(HOSTED_COPY.paused);
	});

	it("403 license errors use the service message, add the fallback, and stop", async () => {
		const { http } = fakeHttp(() => ({ status: 403, json: { ok: false, code: "not_activated", error: "This device is not activated for that key." } }));
		const e = (await hostedGenerate(http, SERVER, REQ).catch((x: unknown) => x)) as HostedError;
		expect(e.code).toBe("auth");
		expect(e.stop).toBe(true);
		expect(e.message).toMatch(/^This device is not activated for that key\. Your own key or Ollama/);
	});

	it("502 provider errors do not stop a folder run; other 5xx and network errors do", async () => {
		const e502 = (await hostedGenerate(fakeHttp(() => ({ status: 502, json: { ok: false, code: "hosted_error" } })).http, SERVER, REQ).catch((x: unknown) => x)) as HostedError;
		expect(e502.message).toBe(HOSTED_COPY.server);
		expect(e502.stop).toBe(false);
		const e503 = (await hostedGenerate(fakeHttp(() => ({ status: 503, json: null })).http, SERVER, REQ).catch((x: unknown) => x)) as HostedError;
		expect(e503.stop).toBe(true);
		const down: HttpFn = async () => {
			throw new Error("offline");
		};
		const en = (await hostedGenerate(down, SERVER, REQ).catch((x: unknown) => x)) as HostedError;
		expect(en.code).toBe("network");
		expect(en.message).toBe(HOSTED_COPY.network);
	});

	it("refuses a non-https server URL without a request", async () => {
		const { http, calls } = fakeHttp(() => ({ status: 200, json: {} }));
		const e = (await hostedGenerate(http, "http://insecure.test", REQ).catch((x: unknown) => x)) as HostedError;
		expect(e.code).toBe("unconfigured");
		expect(calls).toHaveLength(0);
	});

	it("usage check posts key/device only and reads availability", async () => {
		const { http, calls } = fakeHttp(() => ({ status: 200, json: { ok: true, available: false, usage: USAGE } }));
		const r = await hostedUsage(http, SERVER, "CARDSMITH-AAAA", "dev-1");
		expect(r).toEqual({ available: false, usage: USAGE });
		expect(calls[0]!.url).toBe(`${SERVER}/v1/hosted-usage`);
		expect(Object.keys(JSON.parse(calls[0]!.body) as object).sort()).toEqual(["device", "key", "product"]);
	});

	it("usageText", () => {
		expect(usageText(USAGE)).toBe("287 of 300 hosted generations left this month (resets Dec 1).");
		expect(usageText({ plan: "trial", used: 0, limit: 0, remaining: 0, resetsAt: null })).toBe("Hosted generation turns on when your subscription's first payment goes through.");
		expect(usageText(null)).toBe(`Up to ${HOSTED_MONTHLY_GENS} generations a month, ${HOSTED_HOURLY_GENS} an hour.`);
	});

	it("claim check: copy matches the service limits and has no phone number or street address", () => {
		// must equal LIMITS.monthlyGens / LIMITS.hourlyGens in the license worker (src/hosted.ts)
		expect(HOSTED_MONTHLY_GENS).toBe(300);
		expect(HOSTED_HOURLY_GENS).toBe(30);
		expect(HOSTED_COPY.gens).toContain("300 hosted generations");
		expect(HOSTED_COPY.hourly).toContain("30 an hour");
		expect(PRO_FEATURES.hostedAi).toContain("300 generations a month");
		expect(HOSTED_LABEL).toBe("Hosted (Pro, no key needed)");
		const all = [...Object.values(HOSTED_COPY), PRO_FEATURES.hostedAi, readFileSync("README.md", "utf8"), readFileSync("CHANGELOG.md", "utf8")].join("\n");
		expect(all).not.toMatch(/\(\d{3}\)\s*\d{3}-\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4}\b|\b\d+ [A-Z][a-z]+ (St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane)\b/);
		// every limit/quota message points to the free fallback
		for (const k of ["needsPro", "wrongLicense", "declined", "gens", "cost", "hourly", "trial", "paused", "busy", "server", "unconfigured"] as const) {
			expect(HOSTED_COPY[k]).toMatch(/own (API )?key or (a local )?Ollama/);
		}
	});

	it("claim check (fix e): consent screen, README and CHANGELOG numbers match the code and the service", () => {
		const consent = [HOSTED_CONSENT.intro, ...HOSTED_CONSENT.items].join("\n");
		const readme = readFileSync("README.md", "utf8");
		// limits: must equal LIMITS.monthlyGens / hourlyGens / monthlyCostMicroUsd in the license worker
		expect(HOSTED_MONTHLY_BUDGET_USD).toBe(1.5);
		expect(consent).toContain(`${HOSTED_MONTHLY_GENS} generations a month and ${HOSTED_HOURLY_GENS} an hour per license`);
		expect(consent).toContain("$1.50 of AI cost a month");
		expect(consent).toContain("up to the first 24,000 characters");
		expect(MAX_INPUT_CHARS).toBe(24000);
		for (const t of ["300 generations a month", "30 an hour", "$1.50", "24,000 characters", "300 characters", `up to ${PRO_MAX_CARDS} cards`]) expect(readme).toContain(t);
		// who gets it: the only routable model in the worker is Google's (MODEL_ROUTES), zero data retention, no fallbacks
		for (const t of ["Cardsmith service", "OpenRouter", "Google", "zero data retention", "no fallback"]) expect(consent).toContain(t);
		for (const t of ["OpenRouter", "Google", "zero data retention", "Cloudflare"]) expect(readme).toContain(t);
		// what is kept / not sent
		expect(consent).toMatch(/doesn't store or log your note/);
		expect(consent).toMatch(/Custom instructions and the card language setting are not sent/);
		expect(readme).toMatch(/Custom instructions and the card language setting are not sent/);
		expect(consent).toContain("isn't included during a free trial");
		expect(HOSTED_COPY.trial).toContain("isn't included in a free trial");
		expect(readme).not.toMatch(/trial allowance|hosted trial/i);
		// how to switch back
		expect(consent).toContain("Settings → Cardsmith → Model provider");
		expect(readme).toContain("Settings → Cardsmith → Model provider");
	});
});

// ---------- plugin-level (mocked Obsidian, mocked license service) ----------

function makeApp() {
	const vault = new MockVault();
	let active: TFile | null = null;
	const app = {
		vault,
		workspace: { onLayoutReady: (fn: () => void) => fn(), getActiveFile: () => active, getActiveViewOfType: () => null },
		metadataCache: { getFileCache: () => ({ tags: [] }) },
		secretStorage: { getSecret: () => null },
	};
	return { app, vault, setActive: (f: TFile) => (active = f) };
}

const NOTE = "# Cells\nThe cell is the basic unit of life and every organism is made of one or more cells.";
let pro: ReturnType<typeof vi.spyOn> | null = null;
const setPro = (on: boolean) => {
	pro?.mockRestore();
	pro = vi.spyOn(LicenseManager.prototype, "isPro").mockReturnValue(on);
};

async function hostedPlugin(app: unknown, opts: { stripe?: boolean; consent?: boolean } = {}) {
	const p = new CardsmithPlugin(app as never, {} as never);
	await p.onload();
	p.settings.preset = "hosted";
	p.settings.kind = "hosted";
	p.settings.reviewBeforeInsert = false;
	p.settings.hostedConsent = opts.consent ?? true;
	p.settings.license = { key: "CARDSMITH-TEST-KEY", providerId: opts.stripe === false ? "itch" : "stripe", source: "stripe", activationId: "device-123", expiresAt: null, lastValidatedAt: Date.now() };
	return p;
}

/** Minimal editor over a string. */
function editor(text: string) {
	let value = text;
	// positions are plain offsets in this fake
	return {
		getSelection: () => "",
		getValue: () => value,
		setValue: (v: string) => (value = v),
		offsetToPos: (o: number) => o,
		replaceRange: (t: string, from: number, to?: number) => (value = value.slice(0, from) + t + value.slice(to ?? from)),
		get value() {
			return value;
		},
	};
}
const gen = (p: CardsmithPlugin) => (p as unknown as { generateForEditor: (e: unknown, f: TFile) => Promise<void> }).generateForEditor.bind(p);
const genFolder = (p: CardsmithPlugin) => (p as unknown as { generateFolder: (f: TFolder, n?: number) => Promise<void> }).generateFolder.bind(p);

beforeEach(() => {
	notices.length = 0;
	requestLog.length = 0;
	openedModals.length = 0;
	setPro(true);
});
afterEach(() => {
	mockReply.fn = null;
	pro?.mockRestore();
	pro = null;
});

describe("hosted mode in the plugin", () => {
	it("Pro: sends the note to /v1/generate only, inserts cards and saves usage", async () => {
		const { app } = makeApp();
		const p = await hostedPlugin(app);
		p.settings.maxCards = 40;
		mockReply.fn = () => ({ ok: true, text: JSON.stringify({ cards: [{ type: "basic", front: "What is the basic unit of life?", back: "The cell" }] }), usage: USAGE });
		const ed = editor(NOTE);
		await gen(p)(ed, new TFile("Bio/Cells.md"));
		expect(requestLog).toHaveLength(1);
		const req = requestLog[0] as Req;
		expect(req.url).toBe(`${STRIPE_LICENSE_SERVER_URL}/v1/generate`);
		const body = JSON.parse(req.body) as Record<string, unknown>;
		expect(body).toMatchObject({ key: "CARDSMITH-TEST-KEY", device: "device-123", title: "Cells", cards: 40, model: "auto" });
		expect(body.text).toContain("basic unit of life");
		expect(ed.value).toContain("What is the basic unit of life?::The cell");
		expect(p.settings.hostedUsage).toEqual(USAGE);
		expect(openedModals.some((m) => m instanceof HostedConsentModal)).toBe(false);
	});

	const consentModal = () => [...openedModals].reverse().find((m) => m instanceof HostedConsentModal) as HostedConsentModal | undefined;
	const flush = () => new Promise((r) => setTimeout(r, 0));
	const button = (m: HostedConsentModal, text: string) => m.contentEl.find((e) => e.text === text)[0]!;

	it("fix e: first hosted use asks for consent first; nothing is sent until the user accepts, and it asks only once", async () => {
		const { app } = makeApp();
		const p = await hostedPlugin(app, { consent: false });
		mockReply.fn = () => ({ ok: true, text: JSON.stringify({ cards: [{ type: "basic", front: "Q?", back: "A" }] }), usage: USAGE });
		const ed = editor(NOTE);
		const run = gen(p)(ed, new TFile("Bio/Cells.md"));
		await flush();
		const m = consentModal()!;
		expect(m.title).toBe(HOSTED_CONSENT.title);
		const text = m.contentEl.allText();
		for (const item of HOSTED_CONSENT.items) expect(text).toContain(item);
		expect(requestLog).toHaveLength(0); // waiting on the user
		button(m, HOSTED_CONSENT.accept).click();
		await run;
		expect(requestLog).toHaveLength(1);
		expect(p.settings.hostedConsent).toBe(true);
		expect(ed.value).toContain("Q?::A");
		openedModals.length = 0;
		await gen(p)(editor(NOTE), new TFile("Bio/Cells.md"));
		expect(consentModal()).toBeUndefined();
		expect(requestLog).toHaveLength(2);
	});

	it("fix e: Cancel or closing the consent screen sends nothing, says so, asks again next time, and stops a folder run", async () => {
		const { app, vault } = makeApp();
		const p = await hostedPlugin(app, { consent: false });
		mockReply.fn = () => ({ ok: true, text: '{"cards":[]}', usage: USAGE });
		let run = gen(p)(editor(NOTE), new TFile("Bio/Cells.md"));
		await flush();
		button(consentModal()!, HOSTED_CONSENT.cancel).click();
		await run;
		expect(requestLog).toHaveLength(0);
		expect(p.settings.hostedConsent).toBe(false);
		expect(notices.at(-1)).toBe(HOSTED_COPY.declined);
		// Escape / X
		openedModals.length = 0;
		run = gen(p)(editor(NOTE), new TFile("Bio/Cells.md"));
		await flush();
		consentModal()!.close();
		await run;
		expect(requestLog).toHaveLength(0);
		// folder: one prompt, declined, no note sent
		const folder = new TFolder("Course");
		for (let i = 1; i <= 3; i++) {
			vault.files.set(`Course/N${i}.md`, `# N${i} ${NOTE}`);
			folder.children.push(new TFile(`Course/N${i}.md`));
		}
		openedModals.length = 0;
		const f = genFolder(p)(folder);
		for (let i = 0; i < 5 && !consentModal(); i++) await flush();
		button(consentModal()!, HOSTED_CONSENT.cancel).click();
		await f;
		expect(requestLog).toHaveLength(0);
		expect(openedModals.filter((m) => m instanceof HostedConsentModal)).toHaveLength(1);
	});

	it("does not send custom instructions or the language setting in hosted mode", async () => {
		const { app } = makeApp();
		const p = await hostedPlugin(app);
		p.settings.extraInstructions = "SECRET-INSTRUCTION";
		p.settings.language = "Klingon";
		mockReply.fn = () => ({ ok: true, text: '{"cards":[]}', usage: USAGE });
		await gen(p)(editor(NOTE), new TFile("Bio/Cells.md"));
		expect((requestLog[0] as Req).body).not.toMatch(/SECRET-INSTRUCTION|Klingon/);
	});

	it("warns when 10 or fewer hosted generations are left", async () => {
		const { app } = makeApp();
		const p = await hostedPlugin(app);
		mockReply.fn = () => ({ ok: true, text: '{"cards":[{"type":"basic","front":"Q?","back":"A"}]}', usage: { ...USAGE, used: 292, remaining: 8 } });
		await gen(p)(editor(NOTE), new TFile("Bio/Cells.md"));
		expect(notices).toContain("8 of 300 hosted generations left this month (resets Dec 1).");
	});

	it("not Pro: opens the Pro screen and sends nothing", async () => {
		setPro(false);
		const { app } = makeApp();
		const p = await hostedPlugin(app);
		await gen(p)(editor(NOTE), new TFile("Bio/Cells.md"));
		expect(requestLog).toHaveLength(0);
		const m = [...openedModals].reverse().find((x) => x instanceof ProModal) as ProModal | undefined;
		expect(m?.title).toBe("Make cards with no API key");
	});

	it("an itch (non-subscription) key gets the fallback copy and sends nothing", async () => {
		const { app } = makeApp();
		const p = await hostedPlugin(app, { stripe: false });
		await gen(p)(editor(NOTE), new TFile("Bio/Cells.md"));
		expect(requestLog).toHaveLength(0);
		expect(notices.at(-1)).toBe(HOSTED_COPY.wrongLicense);
	});

	it("monthly limit / kill switch: shows the fallback copy and keeps the reported usage", async () => {
		const { app } = makeApp();
		const p = await hostedPlugin(app);
		const used = { ...USAGE, used: 300, remaining: 0 };
		mockReply.fn = () => ({ __status: 429, json: { ok: false, code: "hosted_quota", reason: "gens", error: "x", usage: used } });
		await gen(p)(editor(NOTE), new TFile("Bio/Cells.md"));
		expect(notices.at(-1)).toBe(HOSTED_COPY.gens);
		expect(p.settings.hostedUsage).toEqual(used);
		mockReply.fn = () => ({ __status: 429, json: { ok: false, code: "hosted_quota", reason: "paused", error: "x" } });
		await gen(p)(editor(NOTE), new TFile("Bio/Cells.md"));
		expect(notices.at(-1)).toBe(HOSTED_COPY.paused);
	});

	it("folder run stops at the first quota reply but continues past a provider error", async () => {
		const { app, vault } = makeApp();
		const folder = new TFolder("Course");
		for (let i = 1; i <= 4; i++) {
			const path = `Course/Note${i}.md`;
			vault.files.set(path, `# Note ${i} ${NOTE}`);
			folder.children.push(new TFile(path));
		}
		const p = await hostedPlugin(app);
		let n = 0;
		mockReply.fn = () => {
			n++;
			if (n === 1) return { __status: 502, json: { ok: false, code: "hosted_error", error: "x" } };
			if (n === 2) return { ok: true, text: '{"cards":[{"type":"basic","front":"Q?","back":"A"}]}', usage: USAGE };
			return { __status: 429, json: { ok: false, code: "hosted_quota", reason: "hourly", error: "x" } };
		};
		await genFolder(p)(folder);
		expect(n).toBe(3); // note 4 never sent
		expect(notices).toContain(HOSTED_COPY.hourly);
	});

	it("BYOK/Ollama path is unchanged: goes to the local model, never to the license service", async () => {
		const { app } = makeApp();
		const p = await hostedPlugin(app);
		p.settings.preset = "ollama";
		p.settings.kind = "ollama";
		p.settings.baseUrl = "http://localhost:11434";
		p.settings.model = "llama3.2";
		mockReply.fn = () => ({ message: { content: '{"cards":[{"type":"basic","front":"Q?","back":"A"}]}' } });
		const ed = editor(NOTE);
		await gen(p)(ed, new TFile("Bio/Cells.md"));
		expect(requestLog).toHaveLength(1);
		expect((requestLog[0] as Req).url).toMatch(/^http:\/\/localhost:11434\//);
		expect(ed.value).toContain("Q?::A");
		expect(notices).not.toContain(HOSTED_COPY.firstUse);
	});

	it("settings: hosted hides key/model rows, shows remaining generations, and the Check button refreshes it", async () => {
		const { app } = makeApp();
		const p = await hostedPlugin(app);
		p.settings.hostedUsage = USAGE;
		const tab = new CardsmithSettingTab(app as never, p);
		const items = tab.getSettingDefinitions().flatMap((g) => (g as unknown as { items: { name: string; desc?: string; render: (s: unknown) => void }[] }).items);
		const names = items.map((i) => i.name);
		expect(names).toContain("Hosted generations");
		expect(names).not.toContain("API key");
		expect(names).not.toContain("Model");
		const row = items.find((i) => i.name === "Hosted generations")!;
		expect(row.desc).toBe("287 of 300 hosted generations left this month (resets Dec 1).");
		expect(items.find((i) => i.name === "Model provider")!.desc).toBe(HOSTED_COPY.firstUse);
		mockReply.fn = () => ({ ok: true, available: true, usage: { ...USAGE, used: 20, remaining: 280 } });
		expect(await p.refreshHostedUsage()).toBe("280 of 300 hosted generations left this month (resets Dec 1).");
		expect((requestLog.at(-1) as Req).url).toBe(`${STRIPE_LICENSE_SERVER_URL}/v1/hosted-usage`);
		// render the row with a fake Setting (smoke: no throw)
		const el = new FakeEl();
		const st = { setName: () => st, setDesc: () => st, addButton: (cb: (b: unknown) => void) => { const bc = { setButtonText: () => bc, onClick: () => bc, setDisabled: () => bc, setCta: () => bc }; cb(bc); return st; } };
		expect(() => row.render(st)).not.toThrow();
		expect(el).toBeDefined();
	});

	it("settings, not Pro: the row says it needs Pro", async () => {
		setPro(false);
		const { app } = makeApp();
		const p = await hostedPlugin(app);
		const tab = new CardsmithSettingTab(app as never, p);
		const items = tab.getSettingDefinitions().flatMap((g) => (g as unknown as { items: { name: string; desc?: string }[] }).items);
		expect(items.find((i) => i.name === "Hosted generations")!.desc).toBe(HOSTED_COPY.needsPro);
	});
});

describe("Pro-only gate (Oct 31): hosted mode never calls OpenRouter or any model API directly", () => {
	it("hostedGenerate/hostedUsage only hit the license server, and send no provider key", async () => {
		const seen: { url: string; body: string; headers: string }[] = [];
		const http = (async (req: { url: string; body?: string; headers?: Record<string, string> }) => {
			seen.push({ url: req.url, body: String(req.body ?? ""), headers: JSON.stringify(req.headers ?? {}) });
			return { status: 200, json: { ok: true, text: "{\"cards\":[]}", available: true, usage: USAGE }, text: "" };
		}) as unknown as HttpFn;
		await hostedGenerate(http, STRIPE_LICENSE_SERVER_URL, { key: "CARDSMITH-TEST", device: "device-1-abcdefghijklmnop", title: "t", text: "note", cards: 5, types: ["basic"] }).catch(() => undefined);
		await hostedUsage(http, STRIPE_LICENSE_SERVER_URL, "CARDSMITH-TEST", "device-1-abcdefghijklmnop").catch(() => undefined);
		expect(seen.length).toBeGreaterThan(0);
		for (const r of seen) {
			expect(r.url.startsWith(STRIPE_LICENSE_SERVER_URL + "/v1/")).toBe(true);
			expect(r.url).not.toMatch(/openrouter|openai|anthropic|googleapis/i);
			expect(r.headers + r.body).not.toMatch(/sk-or-|authorization/i);
		}
	});
	it("no OpenRouter URL in the hosted code path source", () => {
		for (const f of ["src/ai/hosted.ts", "src/ui/hosted-consent-modal.ts"]) expect(readFileSync(f, "utf8")).not.toMatch(/openrouter\.ai/i);
	});
});

describe("client timeout (longer than the server's 90 s provider timeout)", () => {
	const REQ2 = { key: "CARDSMITH-AAAAA-BBBBB-CCCCC-DDDDD", device: "device-1-abcdefghijklmnop", title: "t", text: "note", cards: 3, types: ["basic" as const] };
	it("is 100 s, which is longer than the Worker's 90 s provider timeout", () => {
		expect(HOSTED_CLIENT_TIMEOUT_MS).toBe(100_000);
		expect(HOSTED_CLIENT_TIMEOUT_MS).toBeGreaterThan(90_000);
	});
	it("stops waiting on a server that never answers and shows the timeout copy", async () => {
		const http: HttpFn = () => new Promise(() => {});
		const e = (await hostedGenerate(http, SERVER, REQ2, 20).catch((x: unknown) => x)) as HostedError;
		expect(e).toBeInstanceOf(HostedError);
		expect([e.code, e.message]).toEqual(["network", HOSTED_COPY.timeout]);
	});
	it("a reply within the timeout is used normally", async () => {
		const http: HttpFn = async () => ({ status: 200, json: { ok: true, text: '{"cards":[]}' }, text: "" });
		expect((await hostedGenerate(http, SERVER, REQ2, 1000)).text).toBe('{"cards":[]}');
	});
});
