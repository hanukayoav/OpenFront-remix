import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TRANSLATIONS: Record<string, string> = {
  "chat.title": "Quick Chat",
  "chat.category": "Category",
  "chat.phrase": "Phrase",
  "chat.player": "Player",
  "chat.search": "Search player...",
  "chat.build": "Build your message...",
  "chat.send": "Send",
  "chat.cat.help": "Help",
  "chat.cat.attack": "Attack",
  "chat.cat.defend": "Defend",
  "chat.cat.greet": "Greetings",
  "chat.cat.misc": "Miscellaneous",
  "chat.cat.warnings": "Warnings",
  "chat.attack.attack": "Attack [P1]!",
  "chat.attack.mirv": "Launch a MIRV at [P1]!",
  "chat.attack.focus": "Focus fire on [P1]!",
  "chat.attack.finish": "Let's finish off [P1]!",
  "chat.attack.build_warships": "Build Warships!",
  "chat.greet.hello": "Hello!",
};

vi.mock("../../../src/client/Utils", () => ({
  translateText: (key: string) => TRANSLATIONS[key] ?? key,
}));

import { OModal } from "../../../src/client/components/baseComponents/Modal";
import { ChatModal } from "../../../src/client/hud/layers/ChatModal";
import { SendQuickChatEvent } from "../../../src/client/Transport";
import type { GameView, PlayerView } from "../../../src/client/view";
import { EventBus } from "../../../src/core/EventBus";
import { PlayerType } from "../../../src/core/game/Game";

function makePlayer(id: string, name: string, color = "#3b82f6"): PlayerView {
  return {
    id: () => id,
    displayName: () => name,
    isAlive: () => true,
    type: () => PlayerType.Human,
    territoryColor: () => ({ toHex: () => color }),
  } as unknown as PlayerView;
}

describe("ChatModal stale selection state", () => {
  let modal: ChatModal;
  let eventBus: EventBus;
  let sentEvents: SendQuickChatEvent[];
  let sender: PlayerView;
  let recipient: PlayerView;
  let alaska: PlayerView;
  let brazil: PlayerView;

  beforeEach(async () => {
    if (!customElements.get("o-modal")) {
      customElements.define("o-modal", OModal);
    }
    if (!customElements.get("chat-modal")) {
      customElements.define("chat-modal", ChatModal);
    }

    OModal.openCount = 0;
    document.body.style.overflow = "";

    eventBus = new EventBus();
    sentEvents = [];
    eventBus.on(SendQuickChatEvent, (e) => {
      sentEvents.push(e);
    });

    sender = makePlayer("me", "Me", "#22c55e");
    recipient = makePlayer("ally", "Ally", "#eab308");
    alaska = makePlayer("p-alaska", "Alaska", "#ef4444");
    brazil = makePlayer("p-brazil", "Brazil", "#3b82f6");

    modal = document.createElement("chat-modal") as ChatModal;
    modal.g = {
      players: () => [alaska, brazil],
    } as unknown as GameView;
    modal.initEventBus(eventBus);
    document.body.appendChild(modal);
    await flushUpdates();
  });

  afterEach(() => {
    modal.remove();
    OModal.openCount = 0;
    document.body.style.overflow = "";
    vi.restoreAllMocks();
  });

  async function flushUpdates() {
    await modal.updateComplete;
    const oModal = modal.querySelector("o-modal") as OModal | null;
    if (oModal) {
      await oModal.updateComplete;
    }
  }

  function findButtonByText(text: string): HTMLButtonElement {
    const buttons = Array.from(modal.querySelectorAll("button"));
    const match = buttons.find((btn) => btn.textContent?.trim() === text);
    if (!match) {
      throw new Error(`Button with text "${text}" not found`);
    }
    return match;
  }

  function queryPlayerColumn(): Element | null {
    const titles = Array.from(modal.querySelectorAll(".column-title"));
    return titles.find((t) => t.textContent?.trim() === "Player") ?? null;
  }

  function getPreviewText(): string {
    return modal.querySelector(".chat-preview")?.textContent?.trim() ?? "";
  }

  function getSendButton(): HTMLButtonElement {
    const btn = modal.querySelector<HTMLButtonElement>(".chat-send-button");
    if (!btn) {
      throw new Error("Send button not found");
    }
    return btn;
  }

  it("clears selected player and disables Send when switching to another player-targeted phrase", async () => {
    modal.open(sender, recipient);
    await flushUpdates();

    findButtonByText("Attack").click();
    await flushUpdates();
    findButtonByText("Attack [P1]!").click();
    await flushUpdates();
    findButtonByText("Alaska").click();
    await flushUpdates();

    expect(getPreviewText()).toBe("Attack Alaska!");
    expect(getSendButton().disabled).toBe(false);

    // Switch to another player-targeted phrase without picking a player yet.
    findButtonByText("Launch a MIRV at [P1]!").click();
    await flushUpdates();

    expect(getPreviewText()).toBe("Launch a MIRV at [P1]!");
    expect(getSendButton().disabled).toBe(true);
    expect(queryPlayerColumn()).not.toBeNull();

    // Selecting a new player re-enables Send and dispatches the new target ID.
    findButtonByText("Brazil").click();
    await flushUpdates();

    expect(getPreviewText()).toBe("Launch a MIRV at Brazil!");
    expect(getSendButton().disabled).toBe(false);

    getSendButton().click();
    await flushUpdates();

    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0].quickChatKey).toBe("attack.mirv");
    expect(sentEvents[0].target).toBe("p-brazil");
  });

  it("allows changing the selected player while keeping the same phrase", async () => {
    modal.open(sender, recipient);
    await flushUpdates();

    findButtonByText("Attack").click();
    await flushUpdates();
    findButtonByText("Attack [P1]!").click();
    await flushUpdates();
    findButtonByText("Alaska").click();
    await flushUpdates();

    expect(getPreviewText()).toBe("Attack Alaska!");

    findButtonByText("Brazil").click();
    await flushUpdates();

    expect(getPreviewText()).toBe("Attack Brazil!");
    expect(getSendButton().disabled).toBe(false);

    getSendButton().click();
    await flushUpdates();

    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0].quickChatKey).toBe("attack.attack");
    expect(sentEvents[0].target).toBe("p-brazil");
  });

  it("hides Player column, clears search query, and drops player target when switching to a non-player phrase", async () => {
    modal.open(sender, recipient);
    await flushUpdates();

    findButtonByText("Attack").click();
    await flushUpdates();
    findButtonByText("Attack [P1]!").click();
    await flushUpdates();

    const searchInput = modal.querySelector<HTMLInputElement>(
      ".player-search-input",
    );
    expect(searchInput).not.toBeNull();
    searchInput!.value = "ala";
    searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUpdates();

    findButtonByText("Alaska").click();
    await flushUpdates();
    expect(queryPlayerColumn()).not.toBeNull();

    // Switch to a phrase in the same category that does not require a player.
    findButtonByText("Build Warships!").click();
    await flushUpdates();

    expect(queryPlayerColumn()).toBeNull();
    expect(getPreviewText()).toBe("Build Warships!");
    expect(getSendButton().disabled).toBe(false);

    getSendButton().click();
    await flushUpdates();

    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0].quickChatKey).toBe("attack.build_warships");
    expect(sentEvents[0].target).toBeUndefined();

    // Reopen and switch to a player phrase: search input should be cleared.
    modal.open(sender, recipient);
    await flushUpdates();
    findButtonByText("Attack").click();
    await flushUpdates();
    findButtonByText("Attack [P1]!").click();
    await flushUpdates();

    const reopenedSearch = modal.querySelector<HTMLInputElement>(
      ".player-search-input",
    );
    expect(reopenedSearch?.value).toBe("");
  });

  it("hides Player column and drops target when switching categories to a non-player phrase", async () => {
    modal.open(sender, recipient);
    await flushUpdates();

    findButtonByText("Attack").click();
    await flushUpdates();
    findButtonByText("Attack [P1]!").click();
    await flushUpdates();
    findButtonByText("Alaska").click();
    await flushUpdates();

    findButtonByText("Greetings").click();
    await flushUpdates();
    expect(queryPlayerColumn()).toBeNull();
    expect(getPreviewText()).toBe("Build your message...");
    expect(getSendButton().disabled).toBe(true);

    findButtonByText("Hello!").click();
    await flushUpdates();
    expect(queryPlayerColumn()).toBeNull();
    expect(getSendButton().disabled).toBe(false);

    getSendButton().click();
    await flushUpdates();

    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0].quickChatKey).toBe("greet.hello");
    expect(sentEvents[0].target).toBeUndefined();
  });

  it("resets all selection state after sending and reopening", async () => {
    modal.open(sender, recipient);
    await flushUpdates();

    findButtonByText("Attack").click();
    await flushUpdates();
    findButtonByText("Attack [P1]!").click();
    await flushUpdates();
    findButtonByText("Alaska").click();
    await flushUpdates();

    getSendButton().click();
    await flushUpdates();

    modal.open(sender, recipient);
    await flushUpdates();

    expect(queryPlayerColumn()).toBeNull();
    expect(getPreviewText()).toBe("Build your message...");
    expect(getSendButton().disabled).toBe(true);
    expect(modal.querySelector(".chat-option-button.selected")).toBeNull();
  });

  it("resets selection state when dismissed via o-modal close button or backdrop", async () => {
    modal.open(sender, recipient);
    await flushUpdates();

    findButtonByText("Attack").click();
    await flushUpdates();
    findButtonByText("Attack [P1]!").click();
    await flushUpdates();
    findButtonByText("Alaska").click();
    await flushUpdates();

    const oModal = modal.querySelector("o-modal") as OModal;
    const closeEl = oModal.shadowRoot?.querySelector(
      "div.cursor-pointer",
    ) as HTMLElement | null;
    expect(closeEl?.textContent?.trim()).toBe("✕");
    closeEl!.click();
    await flushUpdates();

    expect(oModal.isModalOpen).toBe(false);

    modal.open(sender, recipient);
    await flushUpdates();

    expect(queryPlayerColumn()).toBeNull();
    expect(getPreviewText()).toBe("Build your message...");
    expect(getSendButton().disabled).toBe(true);
    expect(modal.querySelector(".chat-option-button.selected")).toBeNull();

    // Also verify backdrop click dismissal resets state.
    findButtonByText("Attack").click();
    await flushUpdates();
    findButtonByText("Attack [P1]!").click();
    await flushUpdates();
    findButtonByText("Alaska").click();
    await flushUpdates();

    const backdrop = oModal.shadowRoot?.querySelector(
      "aside",
    ) as HTMLElement | null;
    expect(backdrop).not.toBeNull();
    backdrop!.click();
    await flushUpdates();

    expect(oModal.isModalOpen).toBe(false);

    modal.open(sender, recipient);
    await flushUpdates();
    expect(queryPlayerColumn()).toBeNull();
    expect(getPreviewText()).toBe("Build your message...");
    expect(getSendButton().disabled).toBe(true);
  });

  it("clears stale selectedPlayer when openWithSelection is called after a previous player-targeted message", async () => {
    modal.open(sender, recipient);
    await flushUpdates();

    findButtonByText("Attack").click();
    await flushUpdates();
    findButtonByText("Attack [P1]!").click();
    await flushUpdates();
    findButtonByText("Alaska").click();
    await flushUpdates();
    getSendButton().click();
    await flushUpdates();

    modal.openWithSelection("attack", "mirv", sender, recipient);
    await flushUpdates();

    expect(getPreviewText()).toBe("Launch a MIRV at [P1]!");
    expect(getSendButton().disabled).toBe(true);
    expect(queryPlayerColumn()).not.toBeNull();
  });
});
