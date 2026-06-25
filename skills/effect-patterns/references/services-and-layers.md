# Effect Services And Layers

Use this when adding or changing Effect services, dependency tags, layer
builders, and reusable domain abstractions.

## Preferred Shape

Keep the tag and implementation layer together. The public API should read:
yield the service, call domain methods, provide the layer.

```ts
export class Foo extends Context.Service<
  Foo,
  {
    readonly get: (id: FooId) => Effect.Effect<Foo, FooNotFound>;
    readonly save: (foo: Foo) => Effect.Effect<void, FooSaveError>;
  }
>()("@hyper/Foo") {
  static readonly layerNoDeps = Layer.succeed(this, {
    get: Effect.fn("Foo.get")(function* (id) {
      return yield* loadFoo(id);
    }),
    save: Effect.fn("Foo.save")(function* (foo) {
      yield* persistFoo(foo);
    }),
  });
}
```

Inline the service interface inside `Context.Service`. Extract a separate
`FooServiceApi` type only when it is a true domain type independent of the tag.

Use static layer members on the class. Avoid one-off `FooLive` exports for a
single service.

Prefer lowercase `layer` for the default implementation unless the repo already
uses a consistent `Live` convention.

## Layer Builders

If construction takes no arguments, `layerNoDeps` can be a `Layer`.

If construction takes arguments, make `layerNoDeps(args)` build the service
value and wrap it with a named layer helper.

```ts
static readonly layerNoDeps = (options: FooOptions) =>
  Effect.gen(function* () {
    return { get: makeGet(options), save: makeSave(options) };
  });

static readonly layer = (options: FooOptions) =>
  Layer.effect(this, this.layerNoDeps(options));
```

## Domain Abstractions

Make reusable domain abstractions own the Effect service shape. Use
`class Foo extends Domain.Tag<...>()("id", options) {}` when the service is a
specific, named instance of a domain abstraction.

```ts
class CounterMachine extends Machine.Tag<
  CounterMachine,
  CounterState,
  CounterEvent,
  CounterAction
>()("@acme/CounterMachine", {
  initialState: { count: 0 },
  transition: (state, event) => {
    switch (event._tag) {
      case "Increment":
        return { state: { count: state.count + 1 } };
    }
  },
}) {}

const program = Effect.gen(function* () {
  const machine = yield* CounterMachine;
  const step = yield* machine.send({ _tag: "Increment" });
  const current = yield* machine.get;

  return { current, step };
}).pipe(Effect.provide(CounterMachine.layer));
```

Avoid APIs that return nested service namespaces and force consumers to wire the
canonical definition at every call site.

```ts
const CounterMachine = defineMachineServices<CounterState, CounterEvent, CounterAction>()(
  "@acme/CounterMachine",
);

const program = Effect.gen(function* () {
  const machine = yield* CounterMachine.Machine;
  return yield* machine.request({ _tag: "Increment" });
}).pipe(Effect.provide(CounterMachine.Machine.layer(counterDefinition)));
```

A domain abstraction should expose the reusable pieces once:

```ts
Machine.Tag<Self, State, Event, Action>()(id, definition);
Machine.make(definition);
Machine.layer(tag, definition); // only when dynamic layering is needed
```

The `Tag` helper should wrap `Context.Service`, attach the construction effect,
and expose the default `layer`.

```ts
export const Tag =
  <Self, State, Event, Action>() =>
  <const Id extends string>(id: Id, definition: Machine.Definition<State, Event, Action>) =>
    Context.Service<Self, Machine.Machine<State, Event, Action>>()(id, {
      make: Machine.make(definition),
    });
```

Use plain `Context.Service` only when the repo has no stronger domain-specific
tag helper.

Keep definitions and canonical options inline in the tag declaration when they
are intrinsic to that service. Extract definitions only when they are reused,
composed, tested independently, or selected dynamically.

Use domain verbs: `send`, `dispatch`, `get`, `snapshot`, `subscribe`, `run`,
`execute`, or `close`. Use `request` only for real request/response protocols.

## Dependencies

Service methods take domain inputs only. Runtime dependencies come from the
Effect environment.

Do not pass `db`, `config`, `logger`, request context, clocks, clients, or other
deps as method arguments. Model missing deps as small services, not bucket
services.

When one implementation can run against multiple backends, keep one canonical
implementation layer and model the backend choice as a dependency service.

```ts
export class FooConnection extends Context.Service<FooConnection, FooConnectionConfig>()(
  "@hyper/FooConnection",
) {
  static readonly layerCloud = Layer.effect(this, loadCloudConfig);
  static readonly layerDirect = Layer.effect(this, loadDirectConfig);
}

export class Foo extends Context.Service<
  Foo,
  {
    readonly run: (input: FooInput) => Effect.Effect<FooOutput, FooError>;
  }
>()("@hyper/Foo") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const connection = yield* FooConnection;

      return Foo.of({
        run: Effect.fn("Foo.run")(function* (input) {
          return yield* runFoo(connection, input);
        }),
      });
    }),
  );
}
```

At the composition boundary, choose the concrete dependency layer.

```ts
const appLayer = Foo.layer.pipe(Layer.provide(FooConnection.layerDirect));
```

Avoid backend-specific provider layers that duplicate the same service
implementation when only configuration changes.

```ts
Foo.layerCloud();
Foo.layerDirect();
```

Also avoid passing backend config through service methods or helper functions as
if it were domain input.

```ts
const run = (input: FooInput) => runFoo(connection, input);
```

The selected layer already owns the connection. The method should stay
`run(input)`.

## Boundary Composition

Compose runtime and transport adapters at the boundary that owns their lifecycle.
Do not hide request, websocket, durable-object, RPC transport, or server adapter
layers inside an exported domain service layer just because they are needed by
one caller.

```ts
const workerLayer = DomainServer.layer.pipe(
  Layer.provideMerge(WebSocketBridge.layer({ tag: "domain" })),
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(DomainWorkflow.layer),
);
```

Keep exported service layers narrow enough that their inferred public type
describes the service boundary, not every transport dependency used by one
runtime. If a `Layer.Layer<...>` annotation has to list unrelated adapter
services to make an exported layer printable, first ask whether those adapters
belong in the outer runtime composition instead.

## Errors And Inference

Expected failures use tagged or schema errors in the error channel.

Do not throw expected failures. Do not include plain JavaScript `Error` in
public expected service error unions.

Prefer inference. Add explicit `Layer.Layer<...>` annotations only when they
stabilize a true public boundary or fix a real inference problem after the layer
ownership is already right.

## Avoid

- Free-standing `FooServiceLive` constants for a single local service.
- Splitting `foo-service.ts` and `foo-service-live.ts` before there is a real
  ownership boundary.
- Factory APIs that return nested service namespaces for a single canonical
  service.
- Duplicate backend-specific implementation layers when a small dependency
  service can represent the selected connection/config.
- Method arguments for dependencies.
- Exported service layers that also provide transport/runtime adapter layers
  owned by one entrypoint.
- `Effect.runPromise` except at runtime boundaries.
- `as any` or `as never` to force a service/layer shape.
