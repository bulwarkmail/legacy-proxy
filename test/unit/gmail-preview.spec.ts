import { expect, it } from "vitest";
import { snippetPreview } from "../../src/gmail/message.js";

it("decodes the escapes Gmail puts in a snippet", () => {
  expect(snippetPreview("il servizio di &#39;Visura catastale&#39; dell&#39;Agenzia")).toBe(
    "il servizio di 'Visura catastale' dell'Agenzia",
  );
  expect(snippetPreview("Pizza &amp; pasta &lt;subito&gt; &quot;oggi&quot;")).toBe(
    'Pizza & pasta <subito> "oggi"',
  );
  expect(snippetPreview("caff&#xe8; e cornetto&hellip;")).toBe("caffè e cornetto…");
});

it("leaves alone what is not an escape", () => {
  expect(snippetPreview("sconto del 50% su R&D e AT&T")).toBe("sconto del 50% su R&D e AT&T");
  expect(snippetPreview("&nosuchentity; resta")).toBe("&nosuchentity; resta");
});

it("drops the invisible padding bulk senders put after a preheader", () => {
  const padded = `See who reached out, Luca \u{1f91d}${" ͏".repeat(40)}`;
  expect(snippetPreview(padded)).toBe("See who reached out, Luca \u{1f91d}");
  expect(snippetPreview("a​b­c﻿d")).toBe("abcd");
});

it("answers with an empty preview when Gmail sends no snippet", () => {
  expect(snippetPreview(undefined)).toBe("");
  expect(snippetPreview("   ")).toBe("");
});
