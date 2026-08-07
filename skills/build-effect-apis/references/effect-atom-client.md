# Effect API clients

Derive clients from the shared `HttpApi`; keep request types, response types,
and expected errors owned by the contract.

## Inventory the client boundary

Before changing Atom code, locate every `RegistryProvider`, runtime factory,
`AtomHttpApi.Service`, query atom, mutation atom, reactivity-key constructor,
and route aggregate. Confirm the installed `effect` and `@effect/atom-react`
versions before copying signatures.

## Build one Atom API service

Create one module-scoped runtime factory and one `AtomHttpApi.Service`. Share a
memo map when multiple client services must reuse layers.

```ts
import { Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Atom, AtomHttpApi } from "effect/unstable/reactivity";
import { ApplicationApi } from "@app/domain";

export const appRuntime = Atom.context({
  memoMap: Layer.makeMemoMapUnsafe(),
});

export const ApiClient = AtomHttpApi.Service()("ApiClient", {
  api: ApplicationApi,
  httpClient: FetchHttpClient.layer,
  runtime: appRuntime,
  baseUrl: "/api",
  transformClient: (client) =>
    HttpClient.mapRequest(client, (request) =>
      HttpClientRequest.setHeader(request, "x-request-id", requestId()),
    ),
});
```

Define the runtime, service, key constructors, queries, and mutations outside
React renders. Keep browser-only identity access behind the client boundary.

## Define queries

```ts
export const projectKeys = {
  collection: ["projects"] as const,
  project: (id: ProjectId) => [`project:${id}`] as const,
};

export const projectAtom = Atom.family((projectId: ProjectId) =>
  ApiClient.query("projects", "getProject", {
    params: { projectId },
    timeToLive: "5 minutes",
    reactivityKeys: projectKeys.project(projectId),
  }).pipe(Atom.swr({ staleTime: "30 seconds", revalidateOnMount: true })),
);
```

`query(group, endpoint, request)` returns an `Atom<AsyncResult<...>>`. The
service memoizes encoded request keys internally; a public `Atom.family` still
expresses domain ownership and cache policy through a stable scalar or Effect
`Hash`/`Equal` key.

Query options have distinct jobs:

- `timeToLive` controls idle registry retention;
- `reactivityKeys` registers invalidation subscriptions;
- `serializationKey` enables decoded-only hydration serialization and is not
  the runtime cache key;
- `responseMode` changes the response and error shape.

Keep secrets out of serialization keys, URL state, hydration payloads, and
client-visible layers.

## Define mutations and invalidation

```ts
export const updateProjectMutation = ApiClient.mutation("projects", "updateProject");

const updateProject = useAtomSet(updateProjectMutation, { mode: "promise" });

await updateProject({
  params: { projectId },
  payload: patch,
  reactivityKeys: [...projectKeys.collection, ...projectKeys.project(projectId)],
});
```

Successful mutations invalidate matching keys; failed mutations do not.
Centralize reactivity-key constructors because mismatched strings fail silently.
When one mutation affects several exact keys, flatten their arrays; an array
containing key arrays registers those nested arrays as different keys.

Exact array keys invalidate only exact matches. Record-form keys are
hierarchical in current Effect v4 implementations: a property registers both
its broad name and each `property:id` combination. Confirm this against the
installed version before relying on it.

Choose invalidation breadth from the server write:

- invalidate an entity key when only its detail changed;
- invalidate the collection when membership, ordering, totals, or filters can
  change;
- invalidate every affected namespace when a write crosses aggregates.

Combine invalidation with manual refresh only when two requests are intended.
Keep navigation, toasts, form reset, and presentation-level optimistic state
with the initiating UI.

## Use a direct client outside React

```ts
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

const program = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(ApplicationApi, {
    baseUrl: "https://api.example.com",
  });
  return yield* client.projects.getProject({ params: { projectId } });
}).pipe(Effect.provide(FetchHttpClient.layer));
```

Use the direct client in services, scripts, tests, and non-React applications.
Transform the underlying `HttpClient` once for shared headers, tracing, or
base behavior rather than repeating it at every call site.
