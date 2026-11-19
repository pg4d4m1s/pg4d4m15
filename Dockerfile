FROM node:20-slim

# Install python3 and build tools for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# LibreOffice (Writer only) + fonts: the registration form converts uploaded .docx files to PDF for the document preview
# (POST /api/auth/convert-docx-to-pdf). Without it every DOCX preview fails with "LibreOffice error".
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer fonts-liberation fonts-dejavu-core && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
