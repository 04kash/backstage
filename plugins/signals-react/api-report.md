## API Report File for "@backstage/plugin-signals-react"

> Do not edit this file. It is a report generated by [API Extractor](https://api-extractor.com/).

```ts
import { ApiRef } from '@backstage/core-plugin-api';
import { JsonObject } from '@backstage/types';

// @public (undocumented)
export interface SignalApi {
  // (undocumented)
  subscribe<TMessage extends JsonObject = JsonObject>(
    channel: string,
    onMessage: (message: TMessage) => void,
  ): SignalSubscriber;
}

// @public (undocumented)
export const signalApiRef: ApiRef<SignalApi>;

// @public (undocumented)
export interface SignalSubscriber {
  // (undocumented)
  unsubscribe(): void;
}

// @public (undocumented)
export const useSignal: <TMessage extends JsonObject = JsonObject>(
  channel: string,
) => {
  lastSignal: TMessage | null;
  isSignalsAvailable: boolean;
};

// (No @packageDocumentation comment for this package)
```