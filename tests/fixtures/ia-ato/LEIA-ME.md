# Fixtures da sonda de IA do ato

Tudo aqui é **inventado**: nomes, CPFs, e-mails, telefones, OAB e números de processo
(com dígito verificador válido, mas de processos que não existem). Nenhum texto de caso
real entra neste diretório — nem o dos atos, nem a resposta do modelo a eles.

- `casos-sinteticos.json` — os casos que a sonda e os testes usam.
- `respostas-<modelo>-<data>.json` — resposta **crua** do modelo aos casos sintéticos,
  gravada pela sonda (`scripts/sonda-ia-ato.mjs`). **Não editar**: alimenta os testes da
  Etapa 2. Para renovar, rode a sonda de novo e troque o arquivo inteiro.
