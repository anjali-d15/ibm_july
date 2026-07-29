import { Component } from 'react';

/**
 * EditorErrorBoundary — catches rendering errors inside the editor subtree
 * so a component crash cannot take down the entire application.
 */
export default class EditorErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, errorMessage: error?.message ?? 'Unknown error' };
  }

  componentDidCatch(error, info) {
    console.error('[EditorErrorBoundary] caught error:', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, errorMessage: '' });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="editor-boundary-fallback" role="alert">
          <p className="editor-boundary-fallback__title">
            The editor encountered an unexpected error.
          </p>
          <p className="editor-boundary-fallback__detail">
            {this.state.errorMessage}
          </p>
          <button className="btn btn--ghost btn--sm" onClick={this.handleReset}>
            Try to recover
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
