FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY package.v2.json ./

# Use v2 package.json
RUN mv package.v2.json package.json

RUN npm install

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
