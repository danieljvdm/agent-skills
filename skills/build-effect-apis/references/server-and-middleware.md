# Server handlers and middleware

Implement the shared contract with group handlers, application services, and
layers. Confirm names against the installed Effect version; examples here use
the Effect v4 `effect/unstable/httpapi` surface.

## Implement thin group handlers

Resolve application services once in the group builder, then map every endpoint
identifier to one handler.

```ts
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ApplicationApiWithAuth } from "../api";
import { Projects } from "../services/Projects";

export const ProjectsHandlersLive = HttpApiBuilder.group(
  ApplicationApiWithAuth,
  "projects",
  (handlers) =>
    Effect.gen(function* () {
      const projects = yield* Projects;

      return handlers
        .handle("getProject", ({ params }) => projects.get(params.projectId))
        .handle("updateProject", ({ params, payload }) =>
          projects.update(params.projectId, payload),
        );
    }),
);
```

Handlers receive decoded `params`, `query`, `headers`, and `payload`. Check
cross-field invariants at this boundary when schemas cannot express them, then
call one application workflow. Keep persistence, transactions, retries, and
multi-service orchestration in services.

## Attach cross-cutting middleware to the contract

Define a middleware service, declare its possible transport errors and any
request-scoped service it provides, attach it at endpoint, group, or API scope,
and implement it with a layer.

```ts
import { Context, Effect, Layer } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import { ApplicationApi, Unauthorized } from "@app/domain";

export class CurrentActor extends Context.Service<
  CurrentActor,
  {
    readonly id: string;
  }
>()("app/CurrentActor") {}

export class Authenticate extends HttpApiMiddleware.Service<
  Authenticate,
  {
    readonly provides: CurrentActor;
  }
>()("app/Authenticate", { error: Unauthorized }) {}

export const ApplicationApiWithAuth = ApplicationApi.middleware(Authenticate);

export const AuthenticateLive = Layer.succeed(Authenticate, (httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const actor = yield* authenticate(request.headers.authorization);
    return yield* Effect.provideService(httpEffect, CurrentActor, actor);
  }),
);
```

Use `HttpApiSecurity` when the authentication scheme should appear in OpenAPI
and generated clients. Use ordinary middleware for request logging, tenancy,
correlation IDs, or other cross-cutting work. When middleware uses `requires`
and `provides`, confirm ordering from the installed docs: the outer middleware
that requires a service is attached before the inner middleware that provides
it.

Every error a middleware can return belongs in its `error` schema. Decode raw
headers, cookies, and external values before providing request-scoped services.

## Assemble layers at the runtime edge

```ts
const ProjectsHandlersProvided = ProjectsHandlersLive.pipe(Layer.provide(ApplicationServicesLive));

const ApiLive = HttpApiBuilder.layer(ApplicationApiWithAuth, {
  openapiPath: "/api/openapi.json",
}).pipe(
  Layer.provide(ProjectsHandlersProvided),
  Layer.provide(AuthenticateLive),
  Layer.provideMerge(HttpRuntimePrerequisitesLive),
);
```

The exact HTTP platform/router/server layers vary by runtime. Keep that wiring
at the entrypoint, provide all group and middleware layers, and let the type
system expose missing requirements. Verify that the OpenAPI path composes with
any API prefix as intended.

Transport-wide middleware such as CORS may wrap the final HTTP application.
Keep API middleware for contract-visible behavior and runtime HTTP middleware
for concerns that also apply to raw or non-API routes.

## Use response escape hatches deliberately

Return typed success values and declared errors for ordinary endpoints. Use
`HttpServerResponse` when the boundary must pass through an upstream response,
redirect, set cookies, stream, or control a non-default success status or body.
Use Effect request and cookie APIs to parse boundary state. Reserve unsafe JSON
response constructors for values whose safety is established elsewhere; encode
ordinary typed 4xx failures through the endpoint's declared error schemas.
