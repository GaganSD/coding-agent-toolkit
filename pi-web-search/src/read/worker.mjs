import { parentPort, workerData } from "node:worker_threads";

const job = workerData;
if (!parentPort) throw new Error("Extraction worker requires a parent port.");
try {
	const document = job.format === "html" ? await htmlText(job.text) : await pdfText(job.bytes);
	parentPort.postMessage({ ...document, text: document.text.slice(0, job.maxChars + 2) });
} catch {
	parentPort.postMessage(null);
}

async function htmlText(html) {
	const [{ createDocument }, { Readability }, { default: Turndown }] = await Promise.all([
		import("@mixmark-io/domino"), import("@mozilla/readability"), import("turndown"),
	]);
	const document = createDocument(html);
	for (const element of document.querySelectorAll("script,style,template,noscript,iframe,object,embed,svg,canvas,picture,img,video,audio,[hidden],[aria-hidden=true]")) {
		element.parentNode?.removeChild(element);
	}
	for (const element of document.querySelectorAll("a[href]")) element.removeAttribute("href");
	for (const element of document.querySelectorAll("[style]")) {
		if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/iu.test(element.getAttribute("style") ?? "")) {
			element.parentNode?.removeChild(element);
		}
	}
	const visibleLength = textLength(document.body);
	let article = null;
	try { article = new Readability(document.cloneNode(true), { maxElemsToParse: 100_000 }).parse(); } catch { /* Try structural extraction below. */ }
	let content = article?.content ?? "";
	const title = article?.title || document.title || undefined;
	if ((article?.textContent?.replace(/\s/gu, "").length ?? 0) < visibleLength / 2) {
		// A structural extractor retains reference docs and multi-section pages that Readability can skip.
		for (const element of document.querySelectorAll("nav,footer,aside,[role=navigation],[role=banner],[role=contentinfo]")) {
			element.parentNode?.removeChild(element);
		}
		const root = document.querySelector("main,[role=main]") ?? document.body;
		if (textLength(root) > (article?.textContent?.replace(/\s/gu, "").length ?? 0)) content = root.innerHTML;
	}
	const converter = new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced" });
	converter.remove(["img", "picture"]);
	return { text: converter.turndown(content), title };
}

function textLength(element) {
	return (element.textContent ?? "").replace(/\s/gu, "").length;
}

async function pdfText(bytes) {
	const { getDocumentProxy } = await import("unpdf");
	const pdf = await getDocumentProxy(bytes, { useWorkerFetch: false, maxImageSize: 0 });
	try {
		let text = "";
		for (let number = 1; number <= pdf.numPages; number++) {
			const page = await pdf.getPage(number);
			const content = await page.getTextContent();
			for (const item of content.items) {
				if (!("str" in item)) continue;
				text += item.str;
				if (item.hasEOL) text += "\n";
				if (text.length > job.maxChars) return { text };
			}
			if (number < pdf.numPages) text += "\n\n";
			page.cleanup();
		}
		return { text: text.trim() };
	} finally {
		await pdf.loadingTask.destroy();
	}
}
