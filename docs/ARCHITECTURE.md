# Arquitetura HowToo sobre Pterodactyl

## Regra central

A interface HowToo e uma customizacao do Pterodactyl real. Ela nao mantem uma segunda fonte de servidores e nao simula estados de maquina.

```text
Browser
  -> Laravel/Pterodactyl (sessao, CSRF, 2FA e permissoes)
      -> MySQL/Redis (usuarios, servidores e configuracoes)
      -> Wings via API/WebSocket (estado, console, arquivos e energia)
      -> Servicos HowToo server-side (integracoes externas)
```

## Servidores

- A listagem vem dos modelos e endpoints oficiais do Pterodactyl.
- O servidor selecionado e carregado pelo `ServerContext` oficial.
- Console e metricas usam o websocket autenticado do Pterodactyl/Wings.
- Arquivos, bancos, backups, rede e energia continuam protegidos pelas permissoes oficiais.
- A barra lateral apenas organiza essas rotas; ela nao replica a logica delas.

Servidores de teste devem ser criados somente em um ambiente de homologacao e nunca versionados em codigo, seeds ou fixtures de producao.

## Idioma

O middleware Laravel escolhe `pt` ou `en` pelo cabecalho `Accept-Language`. O cliente React faz a mesma escolha com `navigator.languages`. O endpoint de traducoes aceita os lotes produzidos pelo adaptador i18next, mas valida estritamente os idiomas e os nomes dos namespaces.

## Integracoes

As credenciais de Ollama, Steam e CurseForge seguem estas regras:

1. Apenas administradores raiz acessam o formulario.
2. O navegador envia uma chave nova por POST protegido por CSRF, mas nunca recebe a chave atual.
3. O Laravel criptografa o valor com `APP_KEY` antes de persistir.
4. Somente servicos backend leem a chave descriptografada.
5. A URL configuravel do Ollama e validada e normalizada no backend; as demais URLs base pertencem ao codigo.
6. Respostas de provedores devem ser validadas e filtradas antes de qualquer operacao em arquivos.

Nenhuma integracao pode receber acesso irrestrito ao filesystem do host. Operacoes futuras em arquivos devem usar os endpoints autorizados do Pterodactyl/Wings e ficar limitadas ao servidor selecionado.

## Mod IDs do Project Zomboid (Workshop)

`ProjectZomboidModIdResolver` descobre os valores de `id=` dos `mod.info` de cada Workshop item. Fontes, da mais para a menos confiavel:

1. `mod_info`: arquivos ja baixados no servidor do jogo, lidos pelo Wings (`steamapps/workshop/content/108600/<id>`).
2. `remote_mod_info`: somente os `mod.info` baixados da Steam pelo job `ResolveWorkshopModIds` (DepotDownloader anonimo, fila `workshop`).
3. `steam_metadata` / `workshop_description`: metadata do item ou linhas `Mod ID: X` da descricao.

Regras:

- Uma fonte que falha nunca apaga o que uma fonte mais fraca encontrou. O job remoto so e enfileirado quando a Steam (descricao/metadata) nao expoe nenhum Mod ID.
- Item sem Mod ID detectado ainda pode ser adicionado: entra em `WorkshopItems`, o servidor baixa o mod no proximo start e o painel le o `mod.info` instalado, exibindo os ids para ativar na lista lateral.
- O save respeita a lista `Mods` enviada. So itens novos cujo Mod ID o navegador nao conhecia sao resolvidos no backend; um Mod ID desativado de proposito nao volta.
- Quando nada e encontrado, a API devolve `mod_id_reason` (`downloader_unavailable`, `inspection_failed`, `queue_stalled`, `no_published_files`).

Diagnostico dentro do container: `php artisan p:workshop:diagnose <workshop_id> --download [--server=<uuid>]` mostra o resultado de cada fonte e a saida do DepotDownloader. Falhas do job tambem aparecem no log como `Workshop Mod ID inspection failed`. Instalacoes fora do Docker precisam de um worker `php artisan queue:work --queue=workshop` (ou `STEAM_WORKSHOP_QUEUE`) e do script `STEAM_WORKSHOP_DOWNLOADER`; sem eles, a descricao continua sendo usada.

## Atualizacao do upstream

A referencia atual e Pterodactyl `v1.15.1`. Antes de incorporar uma nova versao:

1. Leia as notas de seguranca e migracoes do upstream.
2. Integre os commits em uma branch separada.
3. Resolva conflitos preservando middlewares, politicas e contratos de API oficiais.
4. Rode PHP, TypeScript, build e testes de integracao com MySQL.
5. Valide login, 2FA, websocket, console, arquivos e todas as permissoes de subusuario.
