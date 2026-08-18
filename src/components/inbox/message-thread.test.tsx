// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { MessageThread } from "./message-thread";
import { useChannels } from "@/hooks/use-channels";
import type { Conversation, Contact } from "@/types";
import messages from "../../../messages/en.json";

afterEach(cleanup);

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

// Chainable Supabase query-builder stub — every method returns itself so
// arbitrary `.select().order().eq()` chains work, and it resolves like a
// real supabase-js query (PromiseLike) via `.then`.
function createChainable(result: { data: unknown[]; error: null } = { data: [], error: null }) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "order", "eq", "update", "insert", "delete"]) {
    chain[method] = () => chain;
  }
  chain.then = (
    resolve: (value: typeof result) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function createChannelStub() {
  const channel: Record<string, unknown> = {};
  channel.on = () => channel;
  channel.subscribe = () => channel;
  return channel;
}

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => createChainable(),
    channel: () => createChannelStub(),
    removeChannel: () => {},
    auth: {
      getUser: () => Promise.resolve({ data: { user: null }, error: null }),
    },
  }),
}));

vi.mock("@/hooks/use-channels", () => ({
  useChannels: vi.fn(),
}));

const TWO_CHANNELS = [
  { id: "ch-1", account_id: "a", provider: "meta" as const, label: "Sales", status: "connected" as const, is_default: true, created_at: "", updated_at: "" },
  { id: "ch-2", account_id: "a", provider: "uazapi" as const, label: "Support", status: "connected" as const, is_default: false, created_at: "", updated_at: "" },
];

const ONE_CHANNEL = [TWO_CHANNELS[0]];

const conversation: Conversation = {
  id: "conv-1",
  user_id: "u1",
  contact_id: "contact-1",
  status: "open",
  unread_count: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  channel_id: "ch-2",
};

const contact: Contact = {
  id: "contact-1",
  user_id: "u1",
  account_id: "a",
  phone: "+15551234567",
  name: "Jane Doe",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function baseProps() {
  return {
    conversation,
    contact,
    messages: [],
    onMessagesLoaded: vi.fn(),
    onNewMessage: vi.fn(),
    onUpdateMessage: vi.fn(),
    onStatusChange: vi.fn(),
    onAssignChange: vi.fn(),
    onChannelChange: vi.fn(),
  };
}

describe("message-thread channel switcher", () => {
  it("shows the badge/switcher only when the account has 2+ channels", () => {
    vi.mocked(useChannels).mockReturnValue({
      channels: TWO_CHANNELS,
      loading: false,
      reload: vi.fn(),
    });

    renderWithIntl(<MessageThread {...baseProps()} />);

    expect(screen.getByText("Support (uazapi)")).toBeInTheDocument();
  });

  it("hides the badge/switcher when the account has fewer than 2 channels", () => {
    vi.mocked(useChannels).mockReturnValue({
      channels: ONE_CHANNEL,
      loading: false,
      reload: vi.fn(),
    });

    renderWithIntl(<MessageThread {...baseProps()} />);

    expect(screen.queryByText("Sales (meta)")).not.toBeInTheDocument();
  });
});
