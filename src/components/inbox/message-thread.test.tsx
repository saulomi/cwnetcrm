// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { MessageThread } from "./message-thread";
import { useChannels } from "@/hooks/use-channels";
import { toast } from "sonner";
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

// Spies + controllable result for the one chain the channel-switcher test
// cases below actually care about: `.from('conversations').update(...).eq(...)`.
// Declared via vi.hoisted so the vi.mock factory (hoisted above this file's
// other statements) can close over them.
const { updateSpy, eqSpy, getConversationsUpdateResult, setConversationsUpdateResult } =
  vi.hoisted(() => {
    let result: { data: unknown; error: { message: string } | null } = {
      data: null,
      error: null,
    };
    return {
      updateSpy: vi.fn(),
      eqSpy: vi.fn(),
      getConversationsUpdateResult: () => result,
      setConversationsUpdateResult: (r: typeof result) => {
        result = r;
      },
    };
  });

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "conversations") {
        const chain: Record<string, unknown> = {};
        chain.update = (payload: unknown) => {
          updateSpy(payload);
          return chain;
        };
        chain.eq = (column: string, value: unknown) => {
          eqSpy(column, value);
          return chain;
        };
        chain.then = (
          resolve: (value: ReturnType<typeof getConversationsUpdateResult>) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(getConversationsUpdateResult()).then(resolve, reject);
        return chain;
      }
      return createChainable();
    },
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

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
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
  beforeEach(() => {
    updateSpy.mockClear();
    eqSpy.mockClear();
    setConversationsUpdateResult({ data: null, error: null });
    vi.mocked(useChannels).mockReturnValue({
      channels: TWO_CHANNELS,
      loading: false,
      reload: vi.fn(),
    });
  });

  it("shows the badge/switcher only when the account has 2+ channels", () => {
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

  it("writes the new channel_id to Supabase and calls onChannelChange when a different channel is picked", async () => {
    const user = userEvent.setup();
    const props = baseProps();

    renderWithIntl(<MessageThread {...props} />);

    // conversation.channel_id is 'ch-2' (Support) — pick the other one.
    await user.click(screen.getByRole("combobox"));
    const option = await screen.findByText("Sales (meta)");
    await user.click(option);

    expect(updateSpy).toHaveBeenCalledWith({ channel_id: "ch-1" });
    expect(eqSpy).toHaveBeenCalledWith("id", "conv-1");
    expect(props.onChannelChange).toHaveBeenCalledWith("conv-1", "ch-1");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("toasts an error and does not call onChannelChange when the Supabase update fails", async () => {
    setConversationsUpdateResult({
      data: null,
      error: { message: "boom" },
    });
    const user = userEvent.setup();
    const props = baseProps();

    renderWithIntl(<MessageThread {...props} />);

    await user.click(screen.getByRole("combobox"));
    const option = await screen.findByText("Sales (meta)");
    await user.click(option);

    expect(updateSpy).toHaveBeenCalledWith({ channel_id: "ch-1" });
    expect(toast.error).toHaveBeenCalledWith("Failed to switch channel");
    expect(props.onChannelChange).not.toHaveBeenCalled();
  });
});
