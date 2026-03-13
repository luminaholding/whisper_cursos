# 🎙️ Whisper Cursos

Webapp para transcrição de treinamentos gravados, usando [Whisper.cpp](https://github.com/ggerganov/whisper.cpp) compilado para **WebAssembly (WASM)**. Funciona 100% no browser, sem servidor, sem nuvem.

## 🚀 Como acessar o app agora (modo demo)

1. Acesse diretamente via GitHub Pages (após ativá-lo nas configurações):
   ```
   https://luminaholding.github.io/whisper_cursos/
   ```
2. Ou clone e abra localmente:
   ```bash
   git clone https://github.com/luminaholding/whisper_cursos
   cd whisper_cursos
   # Abra o index.html em um servidor local (necessário para WASM):
   npx serve .
   # Acesse: http://localhost:3000
   ```

> ⚠️ **Por que precisa de servidor local?** Arquivos `.wasm` só funcionam via HTTP(S), não via `file://`. O `npx serve` resolve isso com 1 comando.

---

## ⚙️ Passo a passo: Compilar Whisper.cpp para WASM

### Pré-requisitos

| Ferramenta | Versão mínima | Instalação |
|---|---|---|
| Git | qualquer | `apt install git` / brew / site oficial |
| CMake | ≥ 3.14 | `apt install cmake` / `brew install cmake` |
| Emscripten (emsdk) | ≥ 3.1.x | veja abaixo |
| Python | ≥ 3.8 | necessário para scripts de modelo |
| Node.js | ≥ 18 | para servidor local (`npx serve`) |

---

### Passo 1 — Instalar o Emscripten (emsdk)

```bash
# Clone o emsdk
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk

# Instala e ativa a versão mais recente
./emsdk install latest
./emsdk activate latest

# Ativa variáveis de ambiente (rode SEMPRE antes de compilar)
source ./emsdk_env.sh
# No Windows PowerShell:
# .\emsdk_env.ps1

# Verifique:
emcc --version
```

---

### Passo 2 — Clonar o whisper.cpp

```bash
# Volte para sua pasta de projetos
cd ~/projetos   # ou onde preferir

git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
```

---

### Passo 3 — Baixar um modelo Whisper

Os modelos ficam na pasta `models/`. Escolha um:

| Modelo | Tamanho | Velocidade | Qualidade | Recomendação |
|---|---|---|---|---|
| tiny | ~75 MB | ⚡⚡⚡⚡ | ⭐⭐ | Testes rápidos |
| base | ~142 MB | ⚡⚡⚡ | ⭐⭐⭐ | Uso mobile |
| **small** | **~466 MB** | **⚡⚡** | **⭐⭐⭐⭐** | **✅ Recomendado** |
| medium | ~1.5 GB | ⚡ | ⭐⭐⭐⭐⭐ | Desktop only |

```bash
# Baixa o modelo small em português (melhor custo-benefício)
bash models/download-ggml-model.sh small

# Ou tiny para testes:
# bash models/download-ggml-model.sh tiny
```

> 💡 Para **português brasileiro**, o modelo `small` ou superior é altamente recomendado.

---

### Passo 4 — Compilar para WebAssembly

```bash
# Certifique-se que o emsdk está ativo:
source ~/emsdk/emsdk_env.sh

# Compile o exemplo WASM do whisper.cpp:
cd examples/whisper.wasm
mkdir build && cd build
emcmake cmake ..
make -j4
```

Se a compilação funcionar, você terá na pasta `build/`:
```
whisper.js
whisper.wasm
```

---

### Passo 5 — Copiar arquivos para o projeto

```bash
# De dentro da pasta whisper.cpp/examples/whisper.wasm/build/
cp whisper.js ~/projetos/whisper_cursos/
cp whisper.wasm ~/projetos/whisper_cursos/
cp ~/projetos/whisper.cpp/models/ggml-small.bin ~/projetos/whisper_cursos/
```

Estrutura final esperada:
```
whisper_cursos/
├── index.html
├── whisper.js       ← gerado pelo Emscripten
├── whisper.wasm     ← gerado pelo Emscripten
├── ggml-small.bin   ← modelo baixado
└── README.md
```

---

### Passo 6 — Ativar a transcrição real no index.html

Abra o `index.html` e localize o comentário `// INTEGRAÇÃO WASM:` dentro da função `runWhisperWasm()`. Descomente e ajuste:

```javascript
// Substitua o bloco de placeholder por:
const { createWhisper } = await import('./whisper.js');
const w = await createWhisper();
await w.loadModel('./ggml-small.bin');
const result = await w.transcribe(pcm, lang);
showResult(result.text);
```

> Nota: a API exata pode variar conforme a versão do whisper.cpp. Consulte os comentários dentro de `examples/whisper.wasm/` para ver a interface JS exposta.

---

### Passo 7 — Rodar localmente

```bash
cd ~/projetos/whisper_cursos
npx serve .
# Abra http://localhost:3000 no browser ou no celular (mesma rede WiFi)
```

📱 **Para acessar no celular:** use o IP local da sua máquina:
```
http://192.168.x.x:3000
```
(o comando `npx serve` mostra o IP no terminal)

---

## 🌐 Publicar no GitHub Pages (acesso via internet)

1. No repositório, vá em **Settings → Pages**
2. Em "Source", selecione `Deploy from a branch`
3. Branch: `main`, pasta: `/ (root)`
4. Salve — em ~1 minuto o app estará em:
   ```
   https://luminaholding.github.io/whisper_cursos/
   ```

> ⚠️ O GitHub Pages serve apenas arquivos estáticos. Os arquivos `.wasm` e `.bin` (modelo) devem ser comitados no repositório ou hospedados em outro lugar (ex: CDN) e referenciados por URL.

---

## 🔧 Alternativa mais simples: usar Transformers.js (sem compilação)

Se a compilação do WASM parecer complexa, existe uma alternativa mais direta usando [Transformers.js](https://huggingface.co/docs/transformers.js) da Hugging Face, que já vem com Whisper compilado:

```html
<!-- Adicione no <head> do index.html -->
<script type="module">
  import { pipeline } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
  const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-small');
  // transcriber(audioData) → { text: '...' }
</script>
```

Vantagens:
- ✅ Zero compilação — funciona direto
- ✅ Modelo baixado automaticamente do HuggingFace
- ✅ Suporte nativo a português
- ⚠️ Primeiro uso é mais lento (download do modelo ~250MB em cache)

---

## 📱 Suporte Mobile

| Recurso | Android Chrome | iOS Safari |
|---|---|---|
| Upload de arquivo | ✅ | ✅ |
| Gravação pelo microfone | ✅ | ✅ (iOS 14.3+) |
| WebAssembly | ✅ | ✅ (iOS 14.5+) |
| Transformers.js | ✅ | ✅ |

---

## 🆘 Problemas comuns

**`SharedArrayBuffer is not defined`**
→ O servidor precisa enviar os headers:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```
Com `npx serve` adicione um arquivo `serve.json`:
```json
{
  "headers": [
    {
      "source": "**",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
      ]
    }
  ]
}
```

**Compilação falha com erro de CMake**
→ Verifique se rodou `source emsdk_env.sh` na mesma sessão do terminal antes de compilar.

**Modelo não carrega (arquivo grande)**
→ No GitHub Pages, arquivos acima de 100 MB precisam usar [Git LFS](https://git-lfs.github.com/).
