import * as path from "path";
import TestStatusType from './enums/testStatusType';
import logError from './utils/logError';
import sessionUpload from './utils/sessionUpload';

class TestResult {
  testStatus: TestStatusType;
  testName: string;
  filename: string | null;
  desiredCaps: object | null;
  appiumLog: any[] | null;
  screenshot: string | null;
  pageSource: string | null;
  error: object | null;

  constructor(testStatus: TestStatusType, testName: string, filename: string | null, desiredCaps: object | null, appiumLog: any[] | null, screenshot: string | null, pageSource: string | null, error: object | null) {
    this.testStatus = testStatus;
    this.testName = testName;
    this.filename = filename;
    this.desiredCaps = desiredCaps;
    this.appiumLog = appiumLog;
    this.screenshot = screenshot;
    this.pageSource = pageSource;
    this.error = error;
  }
}

class Tauk {
  private apiToken: string;
  private projectId: string;
  private driver: any;
  private filename: string | null;
  private excluded?: boolean;
  private testResults: TestResult[];

  constructor(apiToken: string, projectId: string, configOptions?: { driver?: any, excluded?: boolean }) {
    this.testResults = [];
    this.apiToken = apiToken;
    this.projectId = projectId;
    this.filename = this.getCallerFilename();

    if (configOptions?.driver) {
      this.driver = configOptions.driver;
    }

    if (configOptions?.excluded) {
      this.excluded = configOptions.excluded;
    }

  }

  private getCallerFilename(): string | null {
    // Save the original format
    const originalStackTraceFormat = Error.prepareStackTrace;

    // Override with function that returns the stack as an NodeJS.CallSite[] instead of string representation
    Error.prepareStackTrace = (_, stack) => stack;

    // Create a new Error, which will have access to the stack as an NodeJS.CallSite[]
    const error = new Error();
    const stack = error.stack as unknown as NodeJS.CallSite[];

    // Restore the original format
    Error.prepareStackTrace = originalStackTraceFormat;

    let currentFilename = stack[0].getFileName();
    let callerFilename;
    for (let i = 1; i < stack.length; i++) {
      callerFilename = stack[i].getFileName();

      if (currentFilename !== callerFilename) {
        break;
      }
    }

    return (callerFilename) ? `${path.basename(callerFilename)}` : null;
  }

  private async getScreenshot() {
    try {
      const screenshot = await this.driver.takeScreenshot();
      return screenshot;
    } catch (error) {
      logError(__dirname, error);
      return null;
    }
  }

  private async getPageSource() {
    try {
      const rawPageSource = await this.driver.getPageSource();
      return rawPageSource;
    } catch (error) {
      logError(__dirname, error);
      return null;
    }
  }

  private async getLog() {
    // Get last 100 log entries, minus the 5 log entries for issuing get_log()
    const sliceRange = {
      start: -105,
      end: -5
    }

    try {
      let log = await this.driver.getLogs('server');
      return log.slice(sliceRange.start, sliceRange.end);
    } catch (error) {
      logError(__dirname, error);
      return null;
    }
  }

  private formatLog(rawLog: any[]): object[] {
    const output = [];
    const ansiEscapeCodes = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
    for (let i = 0; i < rawLog.length; i++) {
      let eventType = rawLog[i].message.split(/\[|\]/)[1];
      let formattedMessage = rawLog[i].message.replace(ansiEscapeCodes, '').trim();

      let formattedEvent = {
        timestamp: rawLog[i].timestamp,
        level: rawLog[i].level,
        type: eventType,
        message: formattedMessage
      }

      output.push(formattedEvent);
    }
    return output;
  }

  private getDesiredCapabilities() {
    try {
      const allCapabilities: any = this.driver.capabilities;
      const desiredCapabilities = allCapabilities.desired;
      return desiredCapabilities;
    } catch (error) {
      logError(__dirname, error);
      return null;
    }
  }

  private formatError(error: Error): object {

    // Separate line and column numbers from a string of the form (URI:Line:Column)
    function extractLocation(urlLike: any) {
      if (urlLike.indexOf(':') === -1) {
        return [urlLike];
      }

      const regExp: RegExp = /(.+?)(?::(\d+))?(?::(\d+))?$/;
      const parts = regExp.exec(urlLike.replace(/[()]/g, ''));

      if (parts !== null) {
        return [parts[1], parts[2] || "", parts[3]];
      }
      else {
        return [];
      }
    }

    const rawErrorStack = (error.stack) ? error.stack.split('\n') : [];

    const formattedErrorStack = rawErrorStack.map(function (line) {
      if (line.indexOf('(eval ') > -1) {
        // Discard the eval information
        line = line.replace(/eval code/g, 'eval').replace(/(\(eval at [^()]*)|(\),.*$)/g, '');
      }

      let sanitizedLine = line.replace(/^\s+/, '').replace(/\(eval code/g, '(');

      // Capture and preseve the parenthesized location "(/foo/my bar.js:12:87)" in
      // case it has spaces in it, as the string is split on \s+ later on
      const location = sanitizedLine.match(/ (\((.+):(\d+):(\d+)\)$)/);

      // Remove the parenthesized location from the line, if it was matched
      sanitizedLine = location ? sanitizedLine.replace(location[0], '') : sanitizedLine;

      const tokens = sanitizedLine.split(/\s+/).slice(1);

      // If a location was matched, pass it to extractLocation() otherwise pop the last token
      const locationParts = extractLocation(location ? location[1] : tokens.pop());
      const functionName = tokens.join(' ') || "";
      const fileName = ['eval', '<anonymous>'].indexOf(locationParts[0]) > -1 ? undefined : locationParts[0];

      return {
        functionName: functionName as string,
        fileName: fileName as string,
        lineNumber: locationParts[1] as number,
        columnNumber: locationParts[2] as number,
        source: line.trim() as string
      };
    });

    return {
      errorType: error.name,
      errorMsg: error.message,
      lineNumber: formattedErrorStack[1].lineNumber,
      invokedFunc: formattedErrorStack[1].functionName,
      codeExecuted: error.message
    }
  }

  public setDriver(driver: any) {
    this.driver = driver;
  }

  public async observe(testCaseName: string, testCaseFunction: () => any): Promise<any> {
    // const tauk = this;
    let testResult: TestResult;

    // If Tauk wasn't initialized with a driver, run the original function and display warning to console
    if (this.driver === null) {
      console.warn("Please provide the driver object to your instance of Tauk.  " +
        "This can be done either during the initialization or afterwards with setDriver()");
      return testCaseFunction();
    }

    return testCaseFunction().catch(
      async (error: Error) => {
        testResult = new TestResult(
          (this.excluded === true) ? TestStatusType.Excluded : TestStatusType.Failed,
          testCaseName,
          this.filename,
          this.getDesiredCapabilities(),
          await this.getLog(),
          await this.getScreenshot(),
          await this.getPageSource(),
          this.formatError(error)
        );

        this.testResults.push(testResult);
        throw error;
      }
    ).then(async () => {
      testResult = new TestResult(
        (this.excluded === true) ? TestStatusType.Excluded : TestStatusType.Passed,
        testCaseName,
        this.filename,
        this.getDesiredCapabilities(),
        await this.getLog(),
        await this.getScreenshot(),
        await this.getPageSource(),
        null
      );

      this.testResults.push(testResult);
    });
  }

  public async upload() {
    for (let i = 0; i < this.testResults.length; i++) {
      let testResult = this.testResults[i];
      let payload = {
        'test-status': TestStatusType[testResult.testStatus].toLowerCase(),
        'test-name': testResult.testName,
        'test-filename': testResult.filename,
        'tags': testResult.desiredCaps,
        'log': (testResult.appiumLog) ? this.formatLog(testResult.appiumLog) : null,
        'screenshot': (testResult.screenshot) ? testResult.screenshot : null,
        'view': (testResult.pageSource) ? testResult.pageSource : null,
        'errors': (testResult.error) ? testResult.error : null,
        'automation-type': 'appium',
        'sdk-language': 'javascript'
      }
      await sessionUpload(this.apiToken, this.projectId, payload, __dirname);
    }
  }

}

export default Tauk;