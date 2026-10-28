import { Component, ComponentChild } from "preact";

export function memo<P extends object>(
  render: (props: P) => ComponentChild,
  isEqual: (prev: P, next: P) => boolean
): (props: P) => ComponentChild {
  class Memoized extends Component<P> {
    shouldComponentUpdate(nextProps: P): boolean {
      return !isEqual(this.props, nextProps);
    }

    render(): ComponentChild {
      return render(this.props);
    }
  }

  return Memoized as unknown as (props: P) => ComponentChild;
}
