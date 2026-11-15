/**
 * Os ícones da aba e da tela inicial do celular, em bytes, para o navegador que não usa o SVG.
 *
 * O console aponta para o símbolo em SVG (`FAVICON_DATA_URI`, em `marca.ts`), mas o Safari e
 * o "Adicionar à tela de início" do iPhone não leem SVG de favicon e mostravam um ícone genérico.
 * Nenhum navegador pede `/favicon.ico` com a chave de API, então a rota é pública, como as fontes.
 *
 * São o MESMO símbolo do logo (o documento azul-marinho com o ✓ verde, sobre o quadrado branco),
 * gerados a partir de `processovivo-simbolo.svg` junto com os do site (site v1.4.9): `.ico` com
 * 16, 32 e 48 px e o PNG de 180 px com fundo branco inteiro, porque o iPhone pinta de preto o
 * canto transparente. Em base64 aqui, e não em arquivo, porque o `tsc` não copia arquivo para
 * `dist/`: o que está no código vai junto na imagem sem mexer no Dockerfile.
 */
export const FAVICON_ICO: Buffer = Buffer.from(
  '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' +
    'AElFTkSuQmCC',
  'base64',
);

export const ICONE_DA_TELA_INICIAL_PNG: Buffer = Buffer.from(
  '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',
  'base64',
);
