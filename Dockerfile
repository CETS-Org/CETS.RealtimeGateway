# Use a lightweight Node image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package.json and install dependencies first (caching layer)
COPY package*.json ./
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Expose the port your app runs on (usually 3000 or 8080)
EXPOSE 5001

# Start the application
CMD ["node", "index.js"]