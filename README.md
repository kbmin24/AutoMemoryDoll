# AutoMemoryDoll
![Screenshot](./resources/Document_generation_demo.png)
A template-driven document generation platform.

## Key Features
* Automated document generation: Generate documents with templated `LaTeX` using `Minijinja` templating engine
* AI enabled: Ability to automatically generate document by connecting LLM service of your choice, with an option to disable AI features at all if needed
* Dataset driven generation: Manage your own datasets (or upload existing CSV!) and simply bind them into your generation workflow.
* Secure, isolated generation: Each generation is done in an isolated Docker container with gVisor, reducing security concerns.

## Deployment

To deploy AutoMemoryDoll, a linux system with Docker and gVisor using [runsc runtime](https://gvisor.dev/docs/user_guide/quick_start/docker/), is required.

1. Copy `app.env.example` to create `.env.app`. Populate `DOCKER_GID` and configure environment variables.

```sh
cp app.env.example .env.app
chmod 600 .env.app
printf '\nDOCKER_GID=%s\n' "$(stat -c %g /var/run/docker.sock)" >> .env.app
```

Read below for the complete list of environment variables.

2. Build and start the containers.
```sh
sudo docker compose --env-file .env.app -f compose.app.yaml up -d --build
```

Initial container compilation might take a long time, since it will download a full `Tectonic` bundle.

3. By default, AutoMemoryDoll requires HTTPS connection for production deployment. To enable HTTPS, put AutoMemoryDoll behind a reverse proxy such as `nginx`, and enable https there. By default, AutoMemoryDoll exposes port `8080`, so make sure all the traffic is routed to `8080`.<br><br>Alternatively, **for testing purposes only**, you may opt to set `API_NODE_ENV=development` in `.env.app`.

## Development Setup

To test AutoMemoryDoll locally, you may want to use this way to run AutoMemoryDoll.

Assuming you are running Linux with Node.js 24+ with Docker Compose and `runsc` installed (as above):

1. Install dependencies, start PostgreSQL and Redis, and build the compiler image.

   ```sh
   npm ci
   npm run services:up
   docker build -t automemorydoll-compiler:local compiler
   ```

2. Create the service account and its private directories. The account needs read access to the checkout and Node installation, including access through their parent directories.

   ```sh
   sudo useradd --system --user-group --shell /usr/sbin/nologin automemorydoll
   sudo install -d -m 0700 -o automemorydoll -g automemorydoll \
     /var/lib/automemorydoll/data /var/lib/automemorydoll/logs
   ```

3. Create `backend/.env` with the following values. Replace the JWT secret with the output of `openssl rand -hex 32`.

   ```dotenv
   DATABASE_URL=postgresql://postgres:local-development-only@127.0.0.1:5432/automemorydoll
   REDIS_URL=redis://127.0.0.1:6379
   JWT_SECRET=replace-with-a-random-secret
   NODE_ENV=development
   PORT=9900
   STORAGE_ROOT=/var/lib/automemorydoll/data
   LOG_DIR=/var/lib/automemorydoll/logs
   COMPILER_IMAGE=automemorydoll-compiler:local
   ```

   ```sh
   sudo chgrp automemorydoll backend/.env
   chmod 640 backend/.env
   ```

4. Generate the Prisma client, apply migrations, and create the initial owner. The owner CLI uses a separate log directory writable by your account.

   ```sh
   npm --workspace backend run db:generate
   npm --workspace backend run db:migrate:deploy
   LOG_DIR="$(mktemp -d)" npm --workspace backend run create-owner
   ```

5. Start the backend, worker, and frontend. Open the localhost URL printed by Vite.

   ```sh
   npm run dev:all -- automemorydoll
   ```

   Press Ctrl+C to stop all three processes. Run `npm run services:down` to stop PostgreSQL and Redis while retaining their data.
