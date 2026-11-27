# Investigação de rede: rota, Cloudflare, MTU, perda e congestionamento TCP / Network investigation

> Coletado em 2026-11-27, **somente leitura**, no node1 (`node1.howto.software`, Wings v1.13.4) e a partir do PC de
> desenvolvimento. Cada item diz se foi **medido**, é **modelo/cálculo** ou **hipótese**. Nada aqui foi alterado em produção.
> Português primeiro; resumo em inglês no fim.

## 1. Onde está o node e o que existe no caminho

| Item | Resultado | Tipo |
|---|---|---|
| IP público do node | `136.34.124.155`, **AS16591 Google Fiber** (acesso residencial, EUA) | medido (DNS 1.1.1.1/8.8.8.8 + ipinfo) |
| Cloudflare | **Não está no caminho.** O registro é *DNS only*; um `HEAD https://node1.howto.software:8443/` foi respondido **direto pelo Wings** (`401 Unauthorized` + cabeçalhos CORS do Wings, sem `cf-ray`/`server: cloudflare`). Logo, **não há limite de 100 MB do Cloudflare** nem buffering de proxy nesse trecho. | medido |
| nginx/proxy no node | Nenhum: o Wings termina TLS direto na 8443 (`nginx`, `cloudflared` inativos; `ss` mostra só o Wings) | medido |
| Painel (nginx/PHP) | Fora do caminho dos dados: só gera a URL assinada. | código |
| Observação | Em algum momento houve uma conexão de IP Cloudflare (104.23.x) na 8443 — provavelmente um serviço que consulta o node; **não** afeta o upload do navegador (que chega pelo IP residencial). | medido (1 amostra) |

Os usuários estão no Brasil e o node nos EUA: **~115–130 ms de RTT é distância, não defeito** (do PC de desenvolvimento: 1.1.1.1 ≈ 117 ms, 8.8.8.8 ≈ 127 ms, node ≈ 116 ms, 0 % de perda em 12–30 pings).

## 2. Kernel e TCP no node1 (somente leitura, sem root)

| Parâmetro | Valor |
|---|---|
| Kernel | 7.0.0-44-generic |
| Controle de congestionamento | **`cubic`** (disponíveis: `reno cubic`; **BBR não está carregado**) |
| qdisc | `fq_codel` |
| `tcp_mtu_probing` | 0 (desligado) |
| SACK / window scaling / ECN | 1 / 1 / 2 |
| `tcp_rmem` (min/def/max) | 4096 / 131072 / **33554432** (32 MiB) — a janela de recepção **não** é limitante |
| `tcp_wmem` max, `rmem_max`, `wmem_max` | 4 MiB |
| `tcp_slow_start_after_idle` | 1 |
| Interface | `eno1` 1 Gb/s full duplex, MTU 1500, 0 erros, 2 descartes RX desde o boot |
| TCP desde o boot (5,6 dias) | `OutSegs` 5 757 857, `RetransSegs` 3 840 (**0,067 %** — dominado por tráfego local), `TCPTimeouts` 764, `TCPSynRetrans` 514 |
| Conexão de upload ativa (`ss -ti`) | `cubic`, RTT 113–155 ms, 613 retransmissões numa conexão e **10 195 noutra** (com `rto` em backoff) — sinal de perda/atraso **no caminho do cliente**, não no node |

## 3. MTU

* Do PC de desenvolvimento ao node, o maior payload sem fragmentar (ping `-f`) foi **1252 B ⇒ MTU do caminho 1280** — o PC sai por um túnel **WireGuard** (adaptador "UID-VPN", MTU 1280), então esse número descreve o **túnel de teste**, não os usuários.
* Nas conexões reais ao node, o `ss` mostrou **MSS 1452** (⇒ MTU 1492, típico de PPPoE) para um cliente e **MSS 1240** (⇒ MTU 1280) para o túnel. Ou seja, caminhos reais com MTU 1492 existem; `tcp_mtu_probing=0` no node só importa se houver *blackhole* de PMTU (não observado).

## 4. Por que o upload de um usuário ficou em ~0,35–0,6 MB/s

* **Medido** no node: duas conexões de upload ativas avançaram ≈0,6 MB/s e ≈0,35 MB/s, com muitas retransmissões; o node estava ocioso.
* **Modelo (cálculo, não medição)**: pela fórmula de Mathis (vazão ≈ MSS/RTT · 1,22/√p), com MSS 1452 B e RTT 0,12 s, uma perda de **0,1 %** limita **uma** conexão TCP a ≈ **0,47 MB/s** — a mesma ordem do observado. Esse modelo **não prova** que a perda real seja 0,1 %; mostra que, com esse RTT, perdas pequenas já explicam a lentidão e que **a vazão de uma conexão é limitada por RTT e perda, não pela banda do link**.
* **Consequência de projeto**: várias conexões TCP somam (cada uma tem sua janela de congestionamento), enquanto aumentar a banda ou otimizar o node **não** ajudaria. Veja o benchmark em `application.wings-ptero`.

## 5. Dois achados que mudam o desenho (medidos num ambiente emulado)

Ver o relatório do benchmark no PR do Wings. Resumo:

1. **HTTP/2 multiplexa tudo numa única conexão TCP** (é o que o navegador faz com um servidor h2): várias requisições paralelas **não** somam vazão em caminhos com perda; só conexões TCP separadas somam (HTTP/1.1, que o Chrome limita a **6 por host**).
2. **O Wings (Go) usa janela de controle de fluxo HTTP/2 de 1 MiB**, o que limita um upload a ≈ janela/RTT ≈ **9 MB/s a 116 ms**, mesmo sem perda. Na fork isso é configurável (`api.upload_sessions.http2_receive_window_mib`; padrão 0 = comportamento upstream).

## 6. O que recomendo verificar/ajustar (nada foi aplicado)

| Ação | Quem | Risco | Observação |
|---|---|---|---|
| Habilitar **BBR** no node (`modprobe tcp_bbr; sysctl net.ipv4.tcp_congestion_control=bbr` + `net.core.default_qdisc=fq`) | root no node | baixo, afeta **todas** as conexões do node | **Não medido**; só testar em homologação. BBR costuma tolerar perda melhor que cubic, mas isso não foi verificado aqui. |
| `net.ipv4.tcp_mtu_probing=1` | root | baixo | Só ajuda se houver *blackhole* de MTU. |
| Manter o FQDN do node em **DNS only** | Cloudflare | — | Colocar em *proxied* limitaria o corpo a 100 MB (Free/Pro). |
| Servir os nodes de usuários brasileiros mais perto (região/ISP) | infraestrutura | alto | Reduzir RTT é o ganho mais direto (vazão ∝ 1/RTT); fora do escopo. |
| `disable_http2` / `http2_receive_window_mib` no Wings fork | root + reinício do Wings | médio | Decidir **depois** de medir em homologação com o caminho real. |

## 7. Comandos para repetir (somente leitura)

```bash
# no node
sysctl net.ipv4.tcp_congestion_control net.ipv4.tcp_available_congestion_control net.core.default_qdisc net.ipv4.tcp_mtu_probing net.ipv4.tcp_rmem net.ipv4.tcp_wmem
ip -s link show eno1; ethtool eno1 | grep -E "Speed|Duplex"
nstat -az TcpRetransSegs TcpOutSegs TcpExtTCPTimeouts
ss -tin state established '( sport = :8443 )'        # RTT, MSS, retrans por conexão
# do cliente
ping -n 30 <node>; ping -f -l 1252 <node>             # RTT/perda/MTU (Windows)
curl -sk -I https://node1.howto.software:8443/        # procurar cf-ray / server: cloudflare
mtr -rwzc 100 node1.howto.software                    # perda por salto (se disponível)
```

---

## English summary

Node1 sits on a **residential Google Fiber IP in the US**, DNS-only, **no Cloudflare and no proxy in the path** (a HEAD to :8443 was answered by Wings itself). Users in Brazil see ~115–130 ms RTT. The node uses **cubic** (no BBR module), 1 Gb/s, MTU 1500, a 32 MiB receive-window ceiling and a low global retransmission rate (0.067 %); the slow uploads' retransmissions are on the client path. By the Mathis model (a calculation, not a measurement) 0.1 % loss caps one TCP connection at ≈0.47 MB/s at 120 ms, matching what was observed. Two design-relevant findings (measured in an emulated environment): HTTP/2 puts every request on one TCP connection, and Go's default 1 MiB HTTP/2 window caps one upload at ≈ window/RTT ≈ 9 MB/s at 116 ms. Nothing here was changed in production; the tuning table lists candidates to test on staging first.
