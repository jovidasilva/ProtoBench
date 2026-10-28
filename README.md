# ProtoBench

Montador e simulador de circuitos para placa perfurada, veroboard, protoboard e Arduino/ESP32 — agora como **PWA** (instala no PC/celular e funciona offline).

## Rodar

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # gera dist/ (typecheck + build + service worker)
npm run preview    # serve o dist/ para testar o PWA
```

## Testes

```bash
npm test           # Vitest: simulação dos exemplos, falhas, interpretador Arduino, migração
npm run test:e2e   # Playwright: abre o app, salva no IndexedDB, recarrega, checa manifest/SW
npm run typecheck
```

Se o Playwright não achar o navegador, rode `npx playwright install chromium` (ou defina `CHROMIUM_PATH`).

## Publicar

O workflow `.github/workflows/ci.yml` roda typecheck, testes e build a cada push e publica no **GitHub Pages** a partir da branch `main`
(em *Settings → Pages*, escolha *Source: GitHub Actions*). Para outro host, `BASE_PATH=/subpasta/ npm run build` e suba o `dist/`.

## Onde ficam os projetos

No **IndexedDB** do navegador (`idb-keyval`), com pedido de armazenamento persistente. Um rascunho vai para o `localStorage` se a aba fechar
no meio de um salvamento e é recuperado na próxima abertura.
Use **Projetos → Exportar** para backup em `.protobench.json`.

## Estrutura

```
src/
  main.ts            ordem de inicialização + registro do service worker
  state.ts           estado mutável compartilhado (app.S = projeto aberto)
  types.ts           modelo de dados v3 (Board, Comp, Trace, Wire, Mcu…)
  core/base.ts       grade, placas, utilitários
  core/analysis.ts   redes, soldas, cruzamentos de trilha, DRC
  parts/catalog.ts   catálogo de peças (desenho, modelo de simulação, checagens)
  sim/solver.ts      MNA + Newton-Raphson (diodo, BJT, MOSFET, regulador, relé, PWM)
  code/arduino.ts    lexer/parser/verificação e interpretador do código Arduino
  ui/                render SVG, painéis, mouse/teclado
  app/projects.ts    projetos salvos, importar/exportar, exemplos, início
tests/  e2e/  scripts/icons.mjs (gera os PNGs a partir de public/favicon.svg)
```

## Próximos passos

- Tipar módulo a módulo (tirar o `// @ts-nocheck` do topo de cada arquivo, usando `src/types.ts`).
- Simulação em Web Worker para circuitos grandes.
- Emulação real do AVR com `avr8js` (roda o .hex compilado) e SPICE com `ngspice` em WebAssembly.
- App desktop com Tauri, se precisar de acesso a portas seriais/arquivos locais.
