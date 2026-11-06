export async function testReviewCopy(expectedCount) {
	const assert = (condition, message) => { if (!condition) throw new Error(message); };
	const findings = [...document.querySelectorAll("[data-review-finding]")];
	assert(findings.length === expectedCount, `expected ${expectedCount} findings, found ${findings.length}`);
	assert(document.querySelectorAll("[data-copy-finding]").length === expectedCount, "one button per finding");
	assert(document.querySelectorAll("[data-finding-markdown]").length === expectedCount, "one Markdown source per finding");
	assert(!document.querySelector("script[src], link[rel=stylesheet], iframe"), "report must use inline resources");
	if (expectedCount === 0) return { findings: 0, passed: true };
	const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
	const details = [...document.querySelectorAll("details")].map(element => [element, element.open]);
	const setClipboard = (value) => Object.defineProperty(navigator, "clipboard", { configurable: true, value });
	const settle = () => new Promise(resolve => setTimeout(resolve, 0));
	const texts = [];
	try {
		for (const [element] of details) element.open = true;
		for (const finding of findings) {
			const button = finding.querySelector("[data-copy-finding]");
			const source = finding.querySelector("[data-finding-markdown]");
			const status = finding.querySelector("[data-copy-status]");
			assert(button?.tagName === "BUTTON" && button.type === "button", "native named copy button required");
			assert(button.textContent.includes("复制为 Markdown") && button.getAttribute("aria-label"), "button must name its finding");
			assert(source?.tagName === "TEXTAREA" && source.readOnly && source.getAttribute("aria-label"), "named readonly source required");
			assert(status && (status.getAttribute("role") === "status" || status.getAttribute("aria-live") === "polite"), "live status required");
			assert(source.value.length > 0, "copy source must not be empty");
			let resolveWrite;
			let copied;
			setClipboard({ writeText(text) { copied = text; return new Promise(resolve => { resolveWrite = resolve; }); } });
			const previousStatuses = findings.map(item => item.querySelector("[data-copy-status]")?.textContent);
			button.click();
			assert(copied === source.value, "only the selected finding text must be sent");
			assert(button.disabled && !status.textContent.includes("已复制"), "pending write must not report success");
			resolveWrite();
			await settle();
			assert(!button.disabled && status.textContent.includes("已复制"), "successful write must restore the button and report success");
			findings.forEach((item, index) => {
				if (item !== finding) assert(item.querySelector("[data-copy-status]")?.textContent === previousStatuses[index], "other finding status changed");
			});
			texts.push(source.value);
		}
		for (const clipboard of [undefined, { writeText: async () => { throw new DOMException("Denied", "NotAllowedError"); } }]) {
			setClipboard(clipboard);
			const finding = findings[clipboard ? findings.length - 1 : 0];
			const button = finding.querySelector("[data-copy-finding]");
			const source = finding.querySelector("[data-finding-markdown]");
			button.click();
			await settle();
			assert(finding.querySelector("[data-copy-status]").textContent.includes("失败"), "failed write must report failure");
			assert(!button.disabled && !source.hidden && source.getClientRects().length > 0, "manual source must be visible after failure");
			assert(source.value === texts[findings.indexOf(finding)], "manual fallback must match the copied text exactly");
			assert(document.activeElement === source && source.selectionStart === 0 && source.selectionEnd === source.value.length, "manual text must be focused and selected");
		}
		return { findings: findings.length, passed: true, markdown: texts };
	} finally {
		if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
		else delete navigator.clipboard;
		for (const [element, open] of details) element.open = open;
	}
}
