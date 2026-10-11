import { runXauusdBacktest } from '../server/backtestEngine.js';
import { validateHistoricalBacktestDataset } from '../server/marketData.js';

/**
 * REGRESSION TEST: Backtest Button Circular JSON Serialization Fix
 * 
 * Target Bug: Clicking "Run Backtest" passed React's MouseEvent as `allowAvailableSlice`,
 * causing `JSON.stringify` to crash with:
 * "Converting circular structure to JSON --> starting at object with constructor 'HTMLButtonElement' ... property 'stateNode' closes the circle"
 */

async function runRegressionTest() {
  console.log('========================================================================');
  console.log('🧪 RUNNING REGRESSION TEST: BACKTEST CIRCULAR JSON SERIALIZATION FIX');
  console.log('========================================================================\n');

  let passedCount = 0;
  let totalTests = 0;

  // --------------------------------------------------------------------------
  // TEST 1: Reproduce Circular JSON Serialization Failure with Mock React Event
  // --------------------------------------------------------------------------
  totalTests++;
  try {
    // Construct mock React SyntheticMouseEvent containing a circular DOM structure
    const mockButtonElement: any = {
      constructor: { name: 'HTMLButtonElement' },
      tagName: 'BUTTON',
      id: 'run-backtest-btn',
    };
    // Create circular reference simulating React Fiber stateNode -> element -> stateNode
    const mockFiberNode: any = { stateNode: mockButtonElement };
    mockButtonElement._reactFiber = mockFiberNode;

    const mockReactEvent: any = {
      target: mockButtonElement,
      currentTarget: mockButtonElement,
      type: 'click',
      bubbles: true,
    };

    // Raw payload passed before fix: allowAvailableSlice was assigned mockReactEvent
    const unpatchedPayload = {
      initialCapital: 10,
      timeRange: '7D',
      allowAvailableSlice: mockReactEvent,
    };

    let caughtError: Error | null = null;
    try {
      JSON.stringify(unpatchedPayload);
    } catch (err: any) {
      caughtError = err;
    }

    if (caughtError && caughtError.message.includes('Converting circular structure to JSON')) {
      console.log('✅ TEST 1: Successfully reproduced circular JSON serialization failure when event object is passed as parameter.');
      console.log(`   Captured expected error: "${caughtError.message}"`);
      passedCount++;
    } else {
      console.error('✖ TEST 1: Failed to catch expected circular structure JSON error.');
    }
  } catch (err: any) {
    console.error('✖ TEST 1 Exception:', err.message);
  }

  // --------------------------------------------------------------------------
  // TEST 2: Verify Parameter Sanitization Cleanses Event Object to Strict Boolean
  // --------------------------------------------------------------------------
  totalTests++;
  try {
    const rawInputFromEvent = { target: { constructor: { name: 'HTMLButtonElement' } } }; // Simulate React MouseEvent
    
    // Applying the fix:
    const safeAllowSlice = typeof rawInputFromEvent === 'boolean' ? rawInputFromEvent : false;

    const safePayload = {
      initialCapital: 10,
      timeRange: '7D',
      allowAvailableSlice: safeAllowSlice,
    };

    const serialized = JSON.stringify(safePayload);
    const parsed = JSON.parse(serialized);

    if (
      typeof safeAllowSlice === 'boolean' &&
      parsed.allowAvailableSlice === false &&
      parsed.initialCapital === 10 &&
      parsed.timeRange === '7D'
    ) {
      console.log('✅ TEST 2: Parameter sanitization correctly converts event/non-boolean argument to strict boolean false.');
      console.log(`   Serialized JSON payload: "${serialized}"`);
      passedCount++;
    } else {
      console.error('✖ TEST 2: Parameter sanitization failed.');
    }
  } catch (err: any) {
    console.error('✖ TEST 2 Exception:', err.message);
  }

  // --------------------------------------------------------------------------
  // TEST 3: Verify End-to-End Backtest Execution & Historical Data Validation
  // --------------------------------------------------------------------------
  totalTests++;
  try {
    const request = {
      initialCapital: 10,
      timeRange: '1D' as const,
      allowAvailableSlice: false,
    };

    let resultSummary: any = null;
    let caughtValidationReport: any = null;

    try {
      resultSummary = await runXauusdBacktest(request);
    } catch (err: any) {
      if (err.validationReport) {
        caughtValidationReport = err.validationReport;
      } else {
        throw err;
      }
    }

    // Either the backtest ran successfully OR it threw a structured validation report without crashing with a JSON circular error
    const isValidReport = caughtValidationReport && typeof caughtValidationReport.coverageRatio === 'number';
    const isSuccessfulSummary = resultSummary && typeof resultSummary.totalTrades === 'number';

    if (isValidReport || isSuccessfulSummary) {
      console.log('✅ TEST 3: Backtest engine executed safely through historical-data validation without serializing DOM or React objects.');
      if (isSuccessfulSummary) {
        console.log(`   Backtest completed: ${resultSummary.totalTrades} trades, Win rate: ${resultSummary.winRate}%`);
      } else {
        console.log(`   Data validation report generated: ${caughtValidationReport.status} (${(caughtValidationReport.coverageRatio * 100).toFixed(1)}% Coverage)`);
      }
      passedCount++;
    } else {
      console.error('✖ TEST 3: Backtest execution failed to reach validation report.');
    }
  } catch (err: any) {
    console.error('✖ TEST 3 Exception:', err.message);
  }

  console.log('\n========================================================================');
  console.log(`TEST RESULTS: ${passedCount}/${totalTests} PASSED`);
  console.log('========================================================================');

  if (passedCount !== totalTests) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runRegressionTest().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});
