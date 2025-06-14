import sounddevice as sd
from clients.python.helpers.agent import Agent
from clients.python.helpers.utils import slow_print



if __name__ == "__main__":
    agent = Agent()
    print("Kurisu is ready to chat!")
    while True:
        prompt = input("\033[32mUser: \033[0m")
        print("\033[31mKurisu:\033[0m", "Thinking...")
        response = agent.process_message(prompt)
        if response is None:
            print("\033[31mKurisu:\033[0m", "I'm malfunctioning. Please try again later.")
        response = response
        jp_response = response #response.split("|")[-1].strip()
        # overwrite the last print line with "Saying..."
        print("\033[F\033[K\033[31mKurisu:\033[0m", "Saying...")
        voice_response = agent.say(jp_response)
        if voice_response is None:
            print("\033[31mKurisu:\033[0m", "I got cough and can't speak. Please try again later.")
        en_response = response #response.split("|")[0].strip()
        # print in color
        slow_print("\033[F\033[K\033[31mKurisu:\033[0m " + en_response)
        sd.wait()
        