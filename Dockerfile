# Use the official Node.js image
FROM node:18

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json first (for better caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all files (including main.js) into the container
COPY . .

# Expose port 8080
EXPOSE 8080

# Set the command to run your server
CMD ["node", "main.js"]
