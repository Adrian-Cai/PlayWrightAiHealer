pipeline {
    agent {
        docker {
            image 'mcr.microsoft.com/playwright:v1.61.0-noble'
            args '-u root:root'
        }
    }

    environment {
        DEEPSEEK_API_KEY = credentials('DEEPSEEK_API_KEY')
        DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
        FEISHU_APP_ID = credentials('FEISHU_APP_ID')
        FEISHU_APP_SECRET = credentials('FEISHU_APP_SECRET')
        FEISHU_CHAT_ID = credentials('FEISHU_CHAT_ID')
        PLAYWRIGHT_REPORT_URL = "${BUILD_URL}playwright-report/"
        JENKINS_BUILD_URL = "${BUILD_URL}"
        RUN_ID = "${BUILD_ID}-${BUILD_TIMESTAMP}"
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Install Dependencies') {
            steps {
                sh 'npm ci'
                sh 'npm install --no-save ts-node@^10.9.2'
            }
        }

        stage('Run Tests') {
            steps {
                sh 'npm run test:ci'
            }
        }
    }

    post {
        always {
            publishHTML([
                allowMissing: false,
                alwaysLinkToLastBuild: true,
                keepAll: true,
                reportDir: 'playwright-report',
                reportFiles: 'index.html',
                reportName: 'Playwright Report'
            ])

            // Archive heal system artifacts
            archiveArtifacts artifacts: 'healer-cache.json,test-results/ai-healer-events.jsonl,test-results/**/*', allowEmptyArchive: true

            // Clean up temp files
            sh 'rm -f healer-cache.json .heal-events.jsonl || true'
        }

        failure {
            // Keep artifacts on failure for investigation
            echo 'Tests failed. Healing artifacts preserved for analysis.'
        }
    }
}
