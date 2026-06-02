console.log("=== AI Mail Sorter loaded ===");

// ==========================================
// DIAGNOSTICKÝ DUMP
// ==========================================
async function runDiagnosticDump() {
  console.log("=== START DIAGNOSTICKÉHO DUMPU ===");
  console.log("[Dump] Dostupnost Thunderbird API:", {
    browser_accounts: typeof browser.accounts !== "undefined",
    browser_folders: typeof browser.folders !== "undefined",
    browser_messages: typeof browser.messages !== "undefined",
    browser_messageTags: typeof browser.messagesTags !== "undefined",
    browser_storage: typeof browser.storage !== "undefined",
    browser_notifications: typeof browser.notifications !== "undefined",
  });

  try {
    const accounts = await browser.accounts.list();
    console.log(`[Dump] Nalezeno účtů: ${accounts.length}`);

    for (let account of accounts) {
      console.log(
        `\n[ÚČET] ID: "${account.id}" | Název: "${account.name}" | Typ: "${account.type}"`,
      );
      const allFolders = await browser.folders.query({ accountId: account.id });
      console.log(`  -> Počet složek: ${allFolders.length}`);
      for (let folder of allFolders) {
        console.log(
          `     Složka: name="${folder.name}", path="${folder.path}", id="${folder.id}", type="${folder.type}"`,
        );
      }
      let rootCandidate = allFolders.find(
        (f) => f.path === "" || f.name === "Root",
      );
      if (rootCandidate) {
        console.log(
          `  -> Kandidát na kořen: ${rootCandidate.name} (id: ${rootCandidate.id})`,
        );
        const fullRoot = await browser.folders.get(rootCandidate.id);
        console.log(
          `  -> Plnohodnotný kořen: name="${fullRoot.name}", path="${fullRoot.path}", id="${fullRoot.id}"`,
        );
      } else {
        console.log(
          `  -> Žádný zjevný kořen, použijeme první složku: ${allFolders[0]?.name}`,
        );
      }
    }
  } catch (err) {
    console.error("[Dump - Chyba]", err);
  }
  console.log("\n=== KONEC DIAGNOSTICKÉHO DUMPU ===");
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

// ==========================================
// PRÁCE SE SLOŽKAMI
// ==========================================

async function getAccountRootFolder(accountId) {
  const allFolders = await browser.folders.query({ accountId: accountId });
  if (!allFolders || allFolders.length === 0) {
    console.error(`[Chyba] Žádné složky pro účet ${accountId}`);
    return null;
  }
  let rootFolder = allFolders.find((f) => f.path === "" || f.name === "Root");
  if (!rootFolder) {
    rootFolder = allFolders[0];
    console.warn(
      `[Varování] Nenalezen standardní kořen, používám první složku: ${rootFolder.name}`,
    );
  }
  const fullFolder = await browser.folders.get(rootFolder.id);
  return fullFolder;
}

async function findOrCreateAiFolder(accountId, targetCategory) {
  const targetName =
    targetCategory.toLowerCase() === "spam"
      ? "AI_Spam"
      : "AI_" +
        targetCategory.charAt(0).toUpperCase() +
        targetCategory.slice(1);

  const rootFolder = await getAccountRootFolder(accountId);
  if (!rootFolder) {
    console.error(
      `[Chyba] Nelze získat kořenovou složku pro účet ${accountId}`,
    );
    return null;
  }

  try {
    const subFolders = await browser.folders.getSubFolders(rootFolder.id);
    let existing = subFolders.find(
      (f) => f.name.toLowerCase() === targetName.toLowerCase(),
    );
    if (existing) {
      console.log(`[Info] Složka již existuje: ${existing.path}`);
      return existing;
    }

    console.log(
      `[Info] Vytvářím složku ${targetName} v kořeni účtu (${rootFolder.path || "/"})`,
    );
    const newFolder = await browser.folders.create(rootFolder.id, targetName);
    await new Promise((r) => setTimeout(r, 500));
    const updatedSubFolders = await browser.folders.getSubFolders(
      rootFolder.id,
    );
    const created = updatedSubFolders.find(
      (f) => f.name.toLowerCase() === targetName.toLowerCase(),
    );
    return created || newFolder;
  } catch (err) {
    console.error("[Chyba] Problém při hledání/vytváření složky:", err);
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
        max_tokens: 15,
      }),
    });

    if (!response.ok) throw new Error(`Server vrátil kód ${response.status}`);
    const data = await response.json();
    const rawContent = data.choices[0]?.message?.content || "";
    let category = rawContent
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");

    console.log(`[Vyhodnoceno] Čistá kategorie od AI: "${category}"`);
    if (!category) return;

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

    let accountId = null;
    if (message.folder && message.folder.accountId) {
      accountId = message.folder.accountId;
    } else {
      const fullMsg = await browser.messages.get(message.id);
      accountId = fullMsg.folder?.accountId;
    }
    if (!accountId) {
      console.error("[Chyba] Nelze určit účet, používám fallback");
      await applyFallback(message, targetCategory);
      return;
    }

    let targetFolder = await findOrCreateAiFolder(accountId, targetCategory);
    if (targetFolder) {
      try {
        console.log(
          `[Akce] Přesouvám do: ${targetFolder.path} (ID: ${targetFolder.id})`,
        );
        // ZDE JE OPRAVA: použijeme targetFolder.id místo celého objektu
        await browser.messages.move([message.id], targetFolder.id);
        console.log(`[Success] Zpráva přesunuta.`);
      } catch (moveError) {
        console.error("[Error] Přesun selhal:", moveError);
        // Zkusíme ještě alternativní způsob: použít cílovou složku jako objekt (kdyby náhodou)
        try {
          await browser.messages.move([message.id], targetFolder);
          console.log(`[Success] Zpráva přesunuta (objektem).`);
        } catch (err2) {
          console.error("[Error] Selhal i druhý pokus o přesun:", err2);
          await applyFallback(message, targetCategory);
        }
      }
    } else {
      console.warn(`[Fallback] Složku se nepodařilo získat/vytvořit.`);
      await applyFallback(message, targetCategory);
    }
  } catch (error) {
    console.error("[Error]", error);
    if (
      error.message.includes("NetworkError") ||
      error.message.includes("Failed to fetch")
    ) {
      showErrorNotification(
        "Chyba spojení",
        "Zkontrolujte, zda běží LM Studio a má zapnuté CORS.",
      );
    }
  }
}

async function applyFallback(message, targetCategory) {
  if (targetCategory === "spam") {
    console.log(`[Akce] Označuji jako SPAM (Junk)...`);
    await browser.messages.update(message.id, { junk: true });
    console.log(`[Success] Zpráva označena jako spam.`);
  } else {
    console.log(`[Akce] Přiřazuji štítek "${targetCategory}"...`);
    let tagKey = await ensureTagExists(targetCategory);
    let currentTags = message.tags || [];
    if (!currentTags.includes(tagKey)) {
      currentTags.push(tagKey);
      await browser.messages.update(message.id, { tags: currentTags });
      console.log(`[Success] Štítek přiřazen.`);
    } else {
      console.log(`[Info] Zpráva už tento štítek má.`);
    }
  }
}

// Spouštěče
browser.messages.onNewMailReceived.addListener(async (folder, messages) => {
  for (let message of messages) {
    await processMessage(message);
  }
});

browser.messageDisplay.onMessagesDisplayed.addListener(
  async (tab, messages) => {
    const messageList = messages.messages || messages;
    if (messageList) {
      for (let message of messageList) {
        await processMessage(message);
      }
    }
  },
);
