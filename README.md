# AutoMemoryDoll

A template-driven document generation platform.

Run the services in separate terminals, passing the existing service account
username to the backend commands:

```bash
npm run dev:backend -- automemorydoll
npm run worker -- automemorydoll
npm run dev:frontend
```

The backend commands may prompt for sudo authentication. Provision the service
account and its storage/log permissions first; see the
[backend setup instructions](backend/README.md#local-service-account-setup).
Omitting the username runs under the invoking account.

Template cards support automatically generated sample-document previews. See
[preview scheduling, private storage and rollout](backend/README.md#automatic-template-previews)
and [compiler preview mode](compiler/README.md#template-preview-mode). After
rebuilding/deploying the compiler image and updated consumer/API, queue missing
previews once with `npm run previews:backfill -- <service-user>`. Preview work
stays out of user job history; no database migration is required.
