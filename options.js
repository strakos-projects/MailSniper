const DEFAULT_PROMPT =
  "You are a smart email assistant. Read the email subject and categorize it into exactly ONE of these categories: Invoice, Work, Newsletter, Spam, Automated, Ad, Other. Reply with ONLY ONE WORD. Subject: '{SUBJECT}'";

document.addEventListener("DOMContentLoaded", async () => {
  let data = await browser.storage.local.get({
    apiUrl: "http://127.0.0.1:1234/v1/chat/completions",
    modelName: "google/gemma-4-e4b",
    systemPrompt: DEFAULT_PROMPT,
  });

  document.getElementById("apiUrl").value = data.apiUrl;
  document.getElementById("modelName").value = data.modelName;
  document.getElementById("systemPrompt").value = data.systemPrompt;
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  const apiUrl = document.getElementById("apiUrl").value.trim();
  const modelName = document.getElementById("modelName").value.trim();
  const systemPrompt = document.getElementById("systemPrompt").value.trim();

  await browser.storage.local.set({ apiUrl, modelName, systemPrompt });

  let status = document.getElementById("status");
  status.textContent = "Settings saved successfully!";
  setTimeout(() => (status.textContent = ""), 3000);
});
