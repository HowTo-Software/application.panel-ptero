# Upload fragmentado e retomável no Wings / Chunked, resumable uploads in Wings

> **Status: implementado** no fork `HowTo-Software/application.wings-ptero` (base: tag **v1.13.4**, branch `howto/v1.13.4`)
> e consumido pelo painel (este repositório). Este documento descreve o **protocolo como foi construído**, as garantias,
> a compatibilidade e os limites. O relatório de benchmark e os procedimentos de instalação/reversão estão no PR e em
> `docs/howto/RESUMABLE-UPLOADS.md` do fork. Português primeiro; resumo em inglês no fim.

## 1. Por que o Wings precisou mudar

O `POST /upload/file` do Wings recebe **um** multipart e grava direto no nome final. Sem mudar o servidor é **impossível**
retomar de um offset, enviar partes em paralelo, validar hash ou garantir que o nome final só exista com o arquivo completo.
Por isso nada disso foi simulado só no frontend.

## 2. Protocolo (todas as rotas autenticadas por JWT em `?token=`)

| Rota | Função |
|---|---|
| `POST /upload/session` | Cria a sessão **ou retorna a existente** (`resumed: true`) com os intervalos de partes já recebidos. |
| `GET /upload/session/:id` | Estado da sessão (partes recebidas, bytes já "hasheados", resultado se concluída). |
| `PUT /upload/session/:id/chunks/:n?sha256=<hex>` | Corpo = exatamente a parte *n* (16 MiB, exceto a última). O Wings grava em streaming no offset, calcula o SHA-256 e **recusa (422) se não bater**. Idempotente. |
| `POST /upload/session/:id/complete` | Confere se tudo chegou, calcula/valida o SHA-256 do **arquivo inteiro**, e faz a troca **atômica** para o nome final. Idempotente. Corpo opcional `{"sha256": "..."}`. |
| `DELETE /upload/session/:id` | Descarta a sessão e libera a cota. |
| `GET /api/system?v=2` | Passa a incluir `capabilities.howto_upload_sessions` (`version`, `chunk_size`, `max_parallel_chunks`, `max_size`, `hash`, `http2`). O Wings original **não** envia essa chave. |

O token (`scope: upload-session`) é assinado pelo painel, **vale para várias requisições** (ao contrário do token único do
upload legado) mas é preso a **uma** sessão, servidor, usuário, diretório, nome e tamanho, e expira em 15 min (o painel emite outro
quando preciso). Sujeito à mesma revogação (denylist) dos demais tokens.

**Sessão determinística (retomar após fechar o navegador).** O painel calcula `session_id = HMAC-SHA256(app.key, [usuário, servidor, diretório, nome, tamanho, mtime])[0:32]`.
Selecionar o mesmo arquivo de novo gera o mesmo id, o Wings encontra a sessão e informa o que já tem. O painel não guarda nada em banco.

## 3. Garantias

* **Nome final só com arquivo completo e verificado.** Os dados vão para `.upload-<id>.part` ao lado do destino; no fim, `renameat(2)` atômico (substitui um arquivo regular existente **mantendo as permissões dele**; nunca substitui pasta/symlink). Antes de concluir, o arquivo existente **não é tocado** (o upload legado o trunca no 1º byte).
* **Isolamento.** Todo acesso a disco passa pelo `Filesystem` do próprio servidor (raiz própria, `openat2`); nomes e diretórios são validados (sem `/`, `..`, NUL; diretório normalizado dentro da raiz); sessões são ligadas a servidor **e** usuário (outro usuário recebe 404, sem saber que existe); o estado da sessão fica **fora do volume** (`<root>/upload-sessions/<servidor>/`, modo 0700/0600), onde processos do jogo não alcançam.
* **Cota.** `HasSpaceFor(tamanho)` ao criar (recusa antes do 1º byte) e escrita contabilizada na cota **do servidor** a cada parte, com **um único handle por sessão** (partes paralelas não contam o mesmo trecho duas vezes). Limite `api.upload_limit` do node aplicado na criação. Abortar/expirar libera a cota.
* **Sem RAM extra.** Streaming com buffer de 256 KiB por parte em andamento (máx. 8 por sessão, 4 sessões por servidor). Nada de arquivo ou parte inteira em memória.
* **Integridade.** SHA-256 por parte (verificado no recebimento) + SHA-256 incremental do arquivo inteiro (prefixo contíguo; estado persistido, então sobrevive a reinício do Wings) + `fdatasync` por parte antes de confirmar.
* **Limpeza automática.** Varredura a cada 5 min remove sessões ociosas (padrão 24 h) **e seus `.part`**, lápides de conclusão expiradas (1 h) e estado de servidores apagados.
* **Compatibilidade.** `POST /upload/file`, SFTP e todos os demais endpoints **não mudam** (suíte upstream inteira passa no CI, incluindo `sftp`). Wings original + painel novo: o painel detecta a ausência da capacidade e usa o upload "regular" da PR #46. Wings novo + painel antigo: as rotas novas simplesmente não são usadas. Nodes dos dois tipos convivem no mesmo painel.

## 4. Limites conhecidos (honestos)

* Janela residual de TOCTOU entre listar o diretório e concluir (outra pessoa criar o arquivo nesse intervalo): a troca atômica só substitui com permissão, mas o painel não bloqueia a criação concorrente.
* O hash do arquivo inteiro é calculado e **devolvido** pelo Wings; o navegador **não** calcula o hash do arquivo inteiro (a Web Crypto não faz hash incremental). A integridade fim a fim é garantida por: hash de cada parte (calculado no navegador e conferido no node) + hash do arquivo inteiro calculado no node a partir do que está em disco.
* `fdatasync` por parte custa I/O; em discos lentos pode limitar a vazão (medir).
* Perda de energia entre a confirmação de uma parte e o `complete` não é coberta além do `fdatasync` por parte.
* Navegadores: com **HTTP/2** todas as requisições paralelas usam **uma** conexão TCP; só HTTP/1.1 (Chrome: até 6 conexões por host) soma conexões — por isso existe `api.upload_sessions.disable_http2`. A decisão de ligá-lo **depende de medir o caminho real**.
* Implantação exige **binário próprio do Wings** (o fork) e reinício do serviço (derruba WebSocket/SFTP por alguns segundos; containers de jogo continuam). Fazer primeiro em **homologação**.

## 5. English summary

Implemented in the fork `HowTo-Software/application.wings-ptero` (base tag v1.13.4). Session API: `POST /upload/session` (create-or-resume), `GET …/:id`, `PUT …/chunks/:n?sha256=` (streamed, verified, idempotent), `POST …/complete` (verifies, hashes the whole file, **atomic** replace keeping permissions), `DELETE`; capability advertised under `capabilities.howto_upload_sessions` in `/api/system?v=2` (absent in upstream Wings, which is how the panel falls back). Signed multi-use JWT bound to one session/server/user/path/name/size; deterministic HMAC session ids let the same file resume after closing the browser. State lives outside the server volume; all disk access goes through the server's own rooted filesystem; quota-accounted with one shared handle per session; no extra RAM; automatic cleanup. Legacy upload, SFTP and every other endpoint are untouched (upstream suite passes). Known limits: residual TOCTOU on replace, no whole-file hash computed in the browser, h2 multiplexing onto one TCP connection, custom Wings binary required.
