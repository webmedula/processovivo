import type { Page } from 'playwright-core';

/**
 * Espera o console terminar de ABRIR a sessão antes de o teste mexer nele.
 *
 * `window.__pv` existe assim que o script é lido, mas a chave guardada só entra em
 * `estado.chave` depois de `/v1/eu` responder, e a tela inicial só se decide depois de
 * `/v1/facetas`. Chamar `__pv.abrir(n)` antes disso pede o processo SEM a chave (401: a
 * tela vira caixa de erro e o botão esperado nunca aparece) ou deixa a carga inicial
 * terminar por cima. Com a máquina ocupada (a suíte inteira rodando) essa corrida
 * aparece em arquivos diferentes a cada rodada; sozinho, o teste passa.
 *
 * O sinal de "pronto" é o mesmo que a pessoa vê: a sessão aberta (`logado()`) e o
 * endereço já trocado pela navegação inicial (`#/atualizacoes`, ou a rota pedida). Depois,
 * a rede quieta: `/v1/assinatura` responde em paralelo e redesenha a aba atual, e um
 * redesenho no meio do teste troca o elemento que ele estava usando. Sem rede quieta em
 * 10 s (uma tela que consulta de tempos em tempos), segue assim mesmo.
 */
export async function esperarConsolePronto(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const w = window as unknown as {
      __pv?: { abrir?: unknown; logado?: () => boolean };
    };
    const h = location.hash;
    return (
      typeof w.__pv?.abrir === 'function' &&
      w.__pv.logado?.() === true &&
      h.startsWith('#/') &&
      h !== '#/' &&
      h !== '#/entrar'
    );
  });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
}

/**
 * Clica num item do menu lateral como a pessoa faria (v0.68.0): de 900 px para baixo o menu é uma gaveta, então
 * primeiro o ☰ da barra de cima; nas outras larguras o item está à vista (por extenso ou só o ícone).
 */
export async function clicarNoMenu(page: Page, seletor: string): Promise<void> {
  const abrir = page.locator('#menu-abrir');
  // Logo depois de entrar o menu ainda não está na tela: espera o que aparecer primeiro, o ☰ ou o item.
  await page.waitForFunction((q) => {
    const visivel = (e: Element | null) =>
      !!e &&
      e.getClientRects().length > 0 &&
      getComputedStyle(e).visibility === 'visible';
    return (
      visivel(document.getElementById('menu-abrir')) || visivel(document.querySelector(q))
    );
  }, seletor);
  if (await abrir.isVisible()) {
    await abrir.click();
    await page.waitForFunction(() => {
      const l = document.getElementById('lateral');
      return !!l && Math.round(l.getBoundingClientRect().left) === 0;
    });
  }
  await page.locator(seletor).click();
}
