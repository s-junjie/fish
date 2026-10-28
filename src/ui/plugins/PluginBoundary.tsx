import { Component, type ComponentChildren } from "preact";

interface Props {
  message: string;
  children: ComponentChildren;
}

/**
 * Preact unmounts the whole tree when a render throws, so an in-realm plugin that
 * trips over its own data would take the canvas with it. A boundary is the whole
 * of what "the plugin crashed" should cost: the panel says so, the document and
 * every other surface keep working.
 */
export class PluginBoundary extends Component<Props, { error: string | null }> {
  state = { error: null as string | null };

  componentDidCatch(error: unknown) {
    this.setState({ error: error instanceof Error ? error.message : String(error) });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="p-3 flex flex-col gap-1 font-sans">
          <div className="text-ui text-ink">{this.props.message}</div>
          <div className="text-micro text-ink-muted break-words">{this.state.error}</div>
        </div>
      );
    }
    return this.props.children;
  }
}
