# Concord

Chat em tempo real para o seu grupo: servidores, canais de texto, mensagens diretas e chamada de voz (WebRTC). Feito com Node.js + Express + Socket.io no back-end e HTML/CSS/JS puro no front-end.

## 1. Rodar no seu computador (teste local)

Pré-requisito: [Node.js](https://nodejs.org) instalado (versão 18 ou mais recente).

```bash
cd concord
npm install
cp .env.example .env      # depois edite o .env e troque o JWT_SECRET
npm start
```

Abra `http://localhost:3000` no navegador. Para testar com um amigo na mesma rede local, descubra seu IP local (`ipconfig` no Windows / `ifconfig` no Mac/Linux) e compartilhe `http://SEU_IP:3000` — mas isso só funciona na mesma rede Wi-Fi.

## 2. Colocar no ar de verdade (para os amigos acessarem de qualquer lugar)

Você precisa hospedar em um serviço que mantenha o servidor rodando o tempo todo. O jeito mais fácil e gratuito para começar é o **Render**.

### Passo a passo no Render (grátis)

1. Crie uma conta em https://render.com (dá pra usar login do GitHub).
2. Suba esta pasta para um repositório no GitHub (crie um repo novo e faça upload dos arquivos, ou use `git init / git add . / git commit / git push`).
3. No Render, clique em **New +** → **Web Service** e conecte o repositório.
4. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Em **Environment Variables**, adicione:
   - `JWT_SECRET` → qualquer texto longo e aleatório (ex: gere em https://randomkeygen.com)
6. Clique em **Create Web Service**. Em alguns minutos o Render te dá uma URL tipo `https://concord-xxxx.onrender.com` — é esse link que você compartilha com seus amigos.

**Importante sobre o plano free do Render:** o servidor "dorme" depois de um tempo sem uso (demora ~30s pra acordar no primeiro acesso) e o armazenamento é temporário — se o serviço reiniciar, as mensagens salvas em `data/db.json` podem ser perdidas. Para uso sério e permanente, dá pra:
- Ativar um **Persistent Disk** no Render (pago, poucos dólares/mês), montando em `/opt/render/project/src/data`, ou
- Trocar o armazenamento em `lib/db.js` por um banco de verdade (Postgres, por exemplo — o Render tem um plano free de Postgres).

### Alternativas ao Render
- **Railway** (railway.app) — parecido, com volume persistente mais simples de configurar.
- **Fly.io** — ótimo para apps com WebSocket, tem volumes persistentes no free tier.

Qualquer uma dessas funciona bem com este projeto sem alterar o código (Socket.io e WebRTC funcionam normalmente).

## 3. Como usar

1. Crie sua conta (usuário + senha).
2. Clique no **+** na barra lateral esquerda para criar um servidor, ou entrar em um usando um código de convite.
3. Ao criar um servidor, você recebe um **código de convite** — mande esse código para os amigos entrarem.
4. Crie canais de texto ou de voz dentro do servidor.
5. Para conversar em privado, clique no ícone de envelope (✉) no topo e use o **+** para procurar um usuário.
6. Para voz, clique em um canal de voz (🔊) — vai pedir permissão de microfone.

## Limitações desta primeira versão (para você saber o que esperar)

- Armazenamento em arquivo JSON — ótimo para um grupo pequeno (até algumas dezenas de pessoas), não pensado para milhares de usuários.
- Voz usa conexão direta entre os participantes (P2P/mesh) — funciona bem até uns 6-8 pessoas na mesma chamada; acima disso a qualidade pode cair.
- Sem upload de imagens/arquivos, sem emojis customizados, sem permissões avançadas de cargo — dá pra evoluir depois se quiser.
- Sem recuperação de senha por e-mail (não tem envio de e-mail configurado).

## Estrutura do projeto

```
concord/
  server.js          → servidor Express + Socket.io (API e tempo real)
  lib/db.js           → armazenamento em JSON
  lib/auth.js         → login, senha e tokens JWT
  public/index.html   → interface
  public/style.css     → visual
  public/app.js         → lógica do cliente (chat, voz, etc.)
  data/db.json          → "banco de dados" (criado automaticamente)
```
