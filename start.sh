docker stop originrouter
docker rm originrouter
docker build -t originrouter .
docker run -d --name originrouter -p 20128:20128 --env-file .env -v originrouter-data:/app/data originrouter