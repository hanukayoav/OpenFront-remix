import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { GameView } from "../../view";

@customElement("in-game-promo")
export class InGamePromo extends LitElement implements Controller {
  public game: GameView;

  createRenderRoot() {
    return this;
  }

  init() {}
  tick() {}
  public hideAd(): void {}

  render() {
    return html``;
  }
}

