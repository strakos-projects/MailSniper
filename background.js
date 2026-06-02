console.log("=== AI Mail Sorter loaded ===");

// ==========================================
// DIAGNOSTICKÝ DUMP (zkrácený)
// ==========================================
async function runDiagnosticDump() {
  console.log("=== START DIAGNOSTICKÉHO DUMPU ===");
  try {
    const accounts = await browser.accounts.list();
    console.log(`[Dump] Nalezeno účtů: ${accounts.length}`);
    for (let account of accounts) {
      const allFolders = await browser.folders.query({ accountId: account.id });
      console.log(
        `[ÚČET] ${account.name} (${account.id}) - složek: ${allFolders.length}`,
      );
    }
  } catch (err) {
    console.error("[Dump - Chyba]", err);
  }
  console.log("=== KONEC DIAGNOSTICKÉHO DUMPU ===");
}
runDiagnosticDump();

// ==========================================
// POMOCNÉ FUNKCE
// ==========================================

async function getMessageBody(messageId) {
  try {
    const fullMessage = await browser.messages.getFull(messageId);
    let bodyText = "";

    function parsePart(part) {
      if (part.body) {
        if (part.contentType && part.contentType.startsWith("text/plain")) {
          bodyText += part.body + "\n";
        } else if (
          part.contentType &&
          part.contentType.startsWith("text/html") &&
          !bodyText
        ) {
          bodyText +=
            part.body
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ") + "\n";
        }
      }
      if (part.parts) {
        for (let p of part.parts) parsePart(p);
      }
    }

    parsePart(fullMessage);
    return bodyText.trim().substring(0, 1500);
  } catch (err) {
    console.error("[Varování] Nelze získat tělo zprávy:", err);
    return "";
  }
}

async function ensureTagExists(category) {
  try {
    let tags = await browser.messagesTags.list();
    let existing = tags.find(
      (t) =>
        t.tag.toLowerCase() === category.toLowerCase() ||
        t.key.toLowerCase() === category.toLowerCase(),
    );
    if (existing) return existing.key;

    let newTag = await browser.messagesTags.create({
      key: category.toLowerCase(),
      tag: category.charAt(0).toUpperCase() + category.slice(1),
      color: "#0078D7",
    });
    return newTag.key;
  } catch (e) {
    console.error("[Varování] Nelze vytvořit štítek:", e);
    return category.toLowerCase();
  }
}

function showErrorNotification(title, detail) {
  browser.notifications.create({
    type: "basic",
    title: title,
    message: detail,
  });
}

async function getAccountRootFolder(accountId) {
  const allFolders = await browser.folders.query({ accountId: accountId });
  if (!allFolders || allFolders.length === 0) return null;
  let rootFolder = allFolders.find((f) => f.path === "" || f.name === "Root");
  if (!rootFolder) rootFolder = allFolders[0];
  return await browser.folders.get(rootFolder.id);
}

async function findOrCreateAiFolder(accountId, targetCategory) {
  const targetName =
    targetCategory.toLowerCase() === "spam"
      ? "AI_Spam"
      : "AI_" +
        targetCategory.charAt(0).toUpperCase() +
        targetCategory.slice(1);

  const rootFolder = await getAccountRootFolder(accountId);
  if (!rootFolder) return null;

  try {
    const subFolders = await browser.folders.getSubFolders(rootFolder.id);
    let existing = subFolders.find(
      (f) => f.name.toLowerCase() === targetName.toLowerCase(),
    );
    if (existing) return existing;

    console.log(`[Info] Vytvářím složku ${targetName}`);
    const newFolder = await browser.folders.create(rootFolder.id, targetName);
    await new Promise((r) => setTimeout(r, 500));
    const updatedSubFolders = await browser.folders.getSubFolders(
      rootFolder.id,
    );
    return (
      updatedSubFolders.find(
        (f) => f.name.toLowerCase() === targetName.toLowerCase(),
      ) || newFolder
    );
  } catch (err) {
    console.error("[Chyba] Problém se složkou:", err);
    return null;
  }
}

// ==========================================
// HLAVNÍ ZPRACOVÁNÍ
// ==========================================
async function processMessage(message) {
  if (!message || !message.subject) return;
  console.log(`\n[Start] Zpracovávám: "${message.subject}"`);

  const bodyText = await getMessageBody(message.id);
  const settings = await browser.storage.local.get({
    apiUrl: "http://127.0.0.1:1234/v1/chat/completions",
    modelName: "google/gemma-4-e4b",
    systemPrompt:
      "You are a smart email assistant. Categorize this email into exactly ONE of these categories: Invoice, Work, Newsletter, Spam, Automated, Ad, Other. Reply with ONLY ONE WORD.\n\nSubject: '{SUBJECT}'\nBody: '{BODY}'",
  });

  let prompt = settings.systemPrompt.replace("{SUBJECT}", message.subject);
  if (prompt.includes("{BODY}")) {
    prompt = prompt.replace("{BODY}", bodyText || "(bez textu)");
  } else {
    prompt += `\n\nEmail Body:\n${bodyText || "(bez textu)"}`;
  }

  try {
    const response = await fetch(settings.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.modelName,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 100,
      }),
    });

    if (!response.ok) throw new Error(`Server vrátil kód ${response.status}`);
    const data = await response.json();
    const messageObj = data.choices[0]?.message || {};
    let rawContent = messageObj.content || "";
    let reasoning = messageObj.reasoning_content || "";

    console.log(`[Debug] Content: "${rawContent}"`);
    if (reasoning)
      console.log(
        `[Debug] Reasoning začátek: "${reasoning.substring(0, 150)}..."`,
      );

    let category = "";

    // Pokud je content prázdný, zkusíme extrahovat z reasoning
    if (!rawContent.trim() && reasoning) {
      const lowerReasoning = reasoning.toLowerCase();
      const keywords = [
        "invoice",
        "work",
        "newsletter",
        "spam",
        "automated",
        "ad",
        "other",
      ];
      for (let kw of keywords) {
        if (lowerReasoning.includes(kw)) {
          category = kw;
          console.log(
            `[Info] Kategorie extrahována z reasoning: "${category}"`,
          );
          break;
        }
      }
    }

    // Pokud stále nemáme kategorii, použijeme rawContent (původní metoda)
    if (!category && rawContent) {
      category = rawContent
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/g, "");
    }

    if (!category) {
      console.warn(
        `[Varování] Nepodařilo se získat kategorii, používám "other"`,
      );
      category = "other";
    }

    console.log(`[Vyhodnoceno] Kategorie: "${category}"`);

    const spamKeywords = [
      "spam",
      "ad",
      "reklama",
      "automat",
      "automated",
      "marketing",
      "junk",
    ];
    let targetCategory = spamKeywords.includes(category) ? "spam" : category;

    let accountId =
      message.folder?.accountId ||
      (await browser.messages.get(message.id)).folder?.accountId;
    if (!accountId) {
      console.error("[Chyba] Nelze určit účet, používám fallback");
      await applyFallback(message, targetCategory);
      return;
    }

    let targetFolder = await findOrCreateAiFolder(accountId, targetCategory);
    if (targetFolder) {
      try {
        console.log(`[Akce] Přesouvám do: ${targetFolder.path}`);
        await browser.messages.move([message.id], targetFolder.id);
        console.log(`[Success] Zpráva přesunuta.`);
      } catch (moveError) {
        console.error("[Error] Přesun selhal:", moveError);
        await applyFallback(message, targetCategory);
      }
    } else {
      await applyFallback(message, targetCategory);
    }
  } catch (error) {
    console.error("[Error]", error);
    if (
      error.message.includes("NetworkError") ||
      error.message.includes("Failed to fetch")
    ) {
      showErrorNotification("Chyba spojení", "Zkontrolujte LM Studio a CORS.");
    }
  }
}

async function applyFallback(message, targetCategory) {
  if (targetCategory === "spam") {
    console.log(`[Akce] Označuji jako SPAM...`);
    await browser.messages.update(message.id, { junk: true });
  } else {
    console.log(`[Akce] Přiřazuji štítek "${targetCategory}"...`);
    let tagKey = await ensureTagExists(targetCategory);
    let currentTags = message.tags || [];
    if (!currentTags.includes(tagKey)) {
      currentTags.push(tagKey);
      await browser.messages.update(message.id, { tags: currentTags });
    }
  }
}

// Spouštěče
browser.messages.onNewMailReceived.addListener(async (folder, messages) => {
  for (let message of messages) await processMessage(message);
});

browser.messageDisplay.onMessagesDisplayed.addListener(
  async (tab, messages) => {
    const messageList = messages.messages || messages;
    if (messageList) {
      for (let message of messageList) await processMessage(message);
    }
  },
);
