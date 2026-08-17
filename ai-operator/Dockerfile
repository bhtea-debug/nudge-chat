# BHT Copilot. JEDEN proces obsługuje trzy rzeczy:
#   /            interfejs właściciela (przeglądarka, telefon)
#   /mcp         Remote MCP dla Claude
#   /webhook/…   wejście dla Connecteam
# plus monitor poczty w tle.
#
# Jedno wdrożenie, jeden wolumen ze stanem, jedno miejsce awarii. Rozdzielenie
# tego na dwie usługi wymagałoby albo dwóch kopii stanu spraw, albo bazy do ich
# uzgadniania — czyli nowej infrastruktury dla problemu, którego nie mamy.
#
# Celowo bez etapu budowania: `tsx` uruchamia TypeScript wprost, a to pozwala
# trzymać obraz i konfigurację w jednym pliku bez artefaktów pośrednich.
# Przy tej wielkości usługi (kilka tysięcy linii, jeden użytkownik) czas startu
# nie jest problemem, a mniej kroków to mniej rzeczy, które mogą się rozjechać.
FROM node:22-alpine

# Nie pracujemy jako root. Obraz node dostarcza użytkownika `node`.
WORKDIR /app

# Zależności osobno od kodu — warstwa npm przebudowuje się tylko przy zmianie
# package-lock.json, nie przy każdej edycji pliku źródłowego.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm install --no-save tsx@^4.19.2 typescript@^5.7.2

COPY src ./src
COPY fixtures ./fixtures
COPY tsconfig.json ./

# Stan Copilota (dziennik spraw, checkpointy) MUSI być na wolumenie trwałym.
# Bez tego każdy restart kontenera zaczyna od zera: sprawy znikają, checkpointy
# przepadają i monitor przeanalizuje wszystko od nowa.
ENV COPILOT_STATE_DIR=/data/state \
    AUDIT_FILE=/data/audyt.jsonl \
    COST_LOG=/data/koszty.jsonl \
    MODE=live \
    MONITOR_IN_PROCESS=1 \
    PORT=8787 \
    NODE_ENV=production

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8787

# Health nie wymaga tokenu i nie wystawia danych firmy — patrz src/bin/mcp-http.ts.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/bin/mcp-http.ts"]
