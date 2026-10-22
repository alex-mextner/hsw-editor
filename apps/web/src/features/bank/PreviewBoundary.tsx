import { Component, type ErrorInfo, type ReactNode } from 'react';

interface PreviewBoundaryProps {
  readonly fallback: ReactNode;
  readonly children: ReactNode;
}

/** A GLB that fails to load (404, corrupt) must not take the whole panel down: show the thumbnail instead. */
export class PreviewBoundary extends Component<PreviewBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn('Bank 3D preview failed', error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
