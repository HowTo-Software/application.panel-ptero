# Upload fragmentado e retomável no Wings — desenho e avaliação / Chunked, resumable uploads in Wings — design and assessment

> **Status: proposta. Nada disto foi implementado, compilado ou testado.** O Wings é um repositório separado (`pterodactyl/wings`);
> a infraestrutura roda **v1.13.4** (confirmado no node1). Esta PR **não** altera o Wings e **não** simula fragmentação só no frontend.

## 1. Por que o Wings precisa mudar

O endpoint atual (`POST /upload/file`, `router/router_server_files.go`) recebe **um** multipart e grava direto no nome final.
Sem alteração no servidor é **impossível**: (a) retomar do offset onde caiu, (b) enviar partes em paralelo na mesma conexão lógica,
(c) validar hash, (d) garantir que o nome final só exista com o arquivo completo. O frontend não consegue fingir nenhuma dessas coisas
sem criar arquivos parciais visíveis ou concatenar no cliente (que não tem acesso ao disco do node).

## 2. Mudanças exatas propostas (Wings)

Arquivos afetados em `pterodactyl/wings`:

| Arquivo | Alteração |
|---|---|
| `router/tokens/upload.go` | Novo payload `UploadSessionPayload` (`server_uuid`, `user_uuid`, `session_id`, `total_size`, `directory`, `name`) com escopo novo `upload-session`. **Reutilizável** durante a sessão (ao contrário do `unique_id` único do upload atual), mas preso a `session_id`, servidor, diretório, nome e expiração. |
| `router/router.go` | Registrar rotas (autenticadas só por JWT, como o upload atual): `POST /upload/session` (criar), `PATCH /upload/session/:id` (enviar parte), `HEAD /upload/session/:id` (consultar offset/lacunas), `POST /upload/session/:id/complete`, `DELETE /upload/session/:id` (abortar). `GET /upload/capabilities` para o painel detectar suporte. |
| `router/router_server_files.go` (ou novo `router_upload_session.go`) | Handlers acima. |
| `server/filesystem/` | Gravar em `.<nome>.<session>.part` **no mesmo diretório**, via `unixFS` (o mesmo `openat2`/raiz do servidor usado hoje → **sem escapar do volume**). Pré-alocar com `fallocate` do tamanho declarado, escrever cada parte com `WriteAt` (sem buffer: `io.Copy` do corpo para `io.NewOffsetWriter`), no `complete` validar tamanho (e SHA-256 se informado) e `rename` atômico para o nome final, depois `chown`. |
| `config/config.go` | `api.upload_session.max_chunk_bytes` (ex.: 8–32 MiB), `max_parallel_chunks`, `session_ttl`, `max_sessions_per_server` (ex.: 4). |
| Rotina de limpeza | Remover `.part` de sessões expiradas (ticker de `server`/cron já existente do Wings) e no boot. |

### Garantias exigidas

* **Isolamento entre servidores/clientes:** a sessão guarda `server_uuid` assinado no JWT; todo acesso ao disco passa por `s.Filesystem()` do servidor correspondente (raiz própria). Nome validado como componente único (sem `/`, `..`), checado por `IsIgnored` como hoje.
* **Sem aumento de RAM/CPU:** nenhum buffering do arquivo; memória por parte = buffer do `io.Copy` (32 KiB). CPU extra só se hash for pedido (SHA-256 incremental por parte; ≈ custo de leitura de disco). Limite de partes paralelas por sessão e de sessões por servidor.
* **Cota de disco:** reservar o `total_size` declarado no `POST /upload/session` (`HasSpaceFor`, já existente) e liberar ao abortar/expirar; respeitar `api.upload_limit` do node (rejeitar com 400 no início, sem receber bytes).
* **Nada incompleto vira "concluído":** o nome final só aparece no `rename` após validar tamanho/hash. Um arquivo existente **não** é truncado durante o envio (diferente de hoje).
* **Idempotência/retomada:** `HEAD` devolve os intervalos já recebidos; o cliente reenvia só as lacunas. Partes repetidas são sobrescritas no mesmo offset (seguro).
* **Compatibilidade:** `POST /upload/file` **permanece** igual (SFTP não é afetado; ele usa outro caminho). Painel novo consulta `GET /upload/capabilities`; se 404 (Wings antigo) → usa o fluxo atual desta PR. Wings novo continua aceitando painel antigo.

## 3. Mudanças no painel (depois do Wings)

* `JwtScope::FileUploadSession` + `FileUploadSessionController` (gera JWT de sessão; mesmo padrão de `FileUploadController`).
* Cliente: partes de 8–16 MiB, **2–4 em paralelo** (a avaliar por medição), retentativa **por parte** com backoff, retomada via `HEAD`, hash SHA-256 por parte calculado em *streaming* (`Blob.slice` + `crypto.subtle.digest` por parte — viável, pois cada parte é pequena), progresso agregado.

## 4. Avaliação de compatibilidade e risco

| Item | Avaliação |
|---|---|
| Versão do Wings | Alvo: **v1.13.4** (a instalada). Requer **build próprio** do Wings (fork) ou PR upstream; o binário em `/usr/local/bin/wings` foi instalado em 15/10 e há `config.yml.bak-before-howtoo`, indicando que o node já é customizado — **verificar de onde vem o binário antes de planejar o fork**. |
| Deploy | Substituir o binário e reiniciar o serviço: **derruba WebSocket/SFTP por alguns segundos**; containers de jogo seguem rodando. Fazer **primeiro em um node de homologação**; node1 hospeda servidores de produção. |
| Risco | Médio: novo código de escrita em disco no caminho de dados. Mitigar com testes de integração (cota, nomes maliciosos, sessões concorrentes, queda no meio, reinício do Wings no meio). |
| Ganho esperado | **Não medido.** Retomada: evita refazer GBs a cada queda (benefício certo para 10 GiB em link instável). Paralelismo: pode aumentar a vazão em links com perda/RTT alto (várias conexões TCP), mas **o ganho só pode ser afirmado após medir** com `scripts/upload-benchmark.mjs` em homologação. |
| Alternativas sem fork | (a) SFTP (já suportado) para arquivos grandes: retomável por clientes como WinSCP/rsync-over-ssh; (b) `pull` de URL remota no Wings (já existe) a partir de um armazenamento com boa banda; (c) `tus`/rclone num sidecar — **fora do escopo de isolamento do Wings**, exigiria novo serviço no node. |

## 5. English summary

Resumable/parallel uploads need server support: today Wings accepts a single multipart POST written straight to the final path. Proposed: a session API (`POST/HEAD/PATCH/complete/DELETE /upload/session`, plus `GET /upload/capabilities`) with a session-scoped JWT, writes to `.name.session.part` through the server's own rooted filesystem (isolation preserved), `WriteAt` per chunk without buffering (no extra RAM), disk reservation up front, size/SHA-256 validation, atomic rename, TTL cleanup, and per-server limits. The legacy endpoint stays; the panel feature-detects and falls back. **Not implemented, not benchmarked.** Requires a custom Wings build and a staged rollout starting on a non-production node.
