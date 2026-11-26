function detectSystemCulture() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  } catch {
    return "en-US";
  }
}

export class LocaleManager {
  constructor(systemCulture = detectSystemCulture()) {
    this.windowsCulture = systemCulture || "en-US";
    this.language = LocaleManager.resolve(this.windowsCulture);
  }

  static resolve(culture) {
    return String(culture ?? "")
      .toLowerCase()
      .startsWith("es")
      ? "es"
      : "en";
  }

  static preference(value) {
    return value === "en" || value === "es" ? value : "auto";
  }

  configure(args = [], preference = "auto") {
    const normalized = LocaleManager.preference(preference);
    this.language =
      normalized === "auto"
        ? LocaleManager.resolve(this.windowsCulture)
        : normalized;

    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "--language") {
        const choice = String(args[++i]).toLowerCase();
        if (choice !== "en" && choice !== "es") {
          throw new Error("--language must be en or es.");
        }
        this.language = choice;
      }
    }
  }

  t(spanish, english) {
    return this.language === "es" ? spanish : english;
  }
}
