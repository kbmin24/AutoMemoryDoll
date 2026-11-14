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
